import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { normalize as normalizePosix } from "node:path/posix";
import { slugifyId, type Config, type RepoConfig } from "../config.js";
import { RepoRegistry, asRepoConfig } from "../repoRegistry.js";
import type { AuthManager, DeviceIdentity } from "../auth/pairing.js";
import type { FileService } from "../git/fileService.js";
import type { GitWrite } from "../git/gitWrite.js";
import type { AgentRegistry } from "../agent/registry.js";
import type { AttachmentStore } from "../agent/attachments.js";
import type { ClaudeSettingsStore } from "../claude/settingsStore.js";
import { ClaudeLoginManager, NoPtyError, NoUrlError } from "../claude/loginManager.js";
import type { AuditLog } from "../util/audit.js";
import type { RepoWatcher } from "../git/repoWatcher.js";
import type { LiveChannel } from "../ws/liveChannel.js";
import type { WorkspaceStore } from "../workspaces/store.js";
import * as fsBrowse from "../fs/fsBrowse.js";
import { BridgeError, badRequest, forbidden, notFound, readOnly, tooLarge, unauthorized } from "../util/errors.js";
import { confine } from "../util/paths.js";
import { PROTOCOL_VERSION } from "../wire.js";
import { BRIDGE_VERSION } from "../version.js";
import * as gitSvc from "../git/gitService.js";
import { WORKTREE } from "../git/gitService.js";
import { getScene } from "../kicad/service.js";
import { getBoardIndex, getBoardLayer } from "../kicad/boardService.js";
import { counterpartPath } from "../kicad/board.js";
import { projectBasename, projectPaths, projectForSheet, describeProject } from "../kicad/project.js";
import type { ProjectParts, UnresolvedReason } from "../kicad/project.js";
import { resolveAll } from "../kicad/modelResolve.js";
import { getManifest, meshCoverage, meshFor, blobPath } from "../kicad/meshCache.js";
import { SexprParseError } from "../kicad/sexpr.js";
import type {
  CheckoutBody, ClaudeLoginSubmitBody, ClaudeSettingsResponse, CommitBody, CreateFileBody, DiffKind,
  PermissionProfile, PushBody, PutClaudeSettingsBody, RenameBody, SaveFileBody, SessionProvider,
  StageBody, StartSessionBody,
} from "../wire.js";

export interface RestDeps {
  cfg: Config;
  auth: AuthManager;
  audit: AuditLog;
  files: FileService;
  gitWrite: GitWrite;
  agents: AgentRegistry;
  attachments: AttachmentStore;
  claudeSettings: ClaudeSettingsStore;
  claudeLogin: ClaudeLoginManager;
  workspaces: WorkspaceStore;
  /** Shared config-repos + served-workspaces registry (also used by the live channel). */
  registry: RepoRegistry;
  watcher: RepoWatcher;
  live: LiveChannel;
}

interface OpenWorkspaceBody {
  root: string;
  path?: string;
  initGit?: boolean;
  provider?: SessionProvider;
  profile?: PermissionProfile;
}

/** Shape returned per-repo by GET /v1/repos (and by POST /v1/workspaces/open). */
async function repoSummary(r: RepoConfig, removable = false) {
  return {
    id: r.id, name: r.name, defaultBranch: "main", provider: r.provider, profile: r.profile, removable,
    ...(await gitSvc.repoState(r.path)), // branch, ahead?, behind?, dirty
  };
}

const AUTH_EXEMPT = new Set(["/v1/health", "/v1/pair"]);

// The authenticated device rides on the request so writes can be attributed in the audit log
// (ADR-035) — with several devices connected, an unattributed "app" entry is close to useless.
declare module "fastify" {
  interface FastifyRequest {
    device?: DeviceIdentity;
  }
}

export async function buildServer(deps: RestDeps): Promise<FastifyInstance> {
  const { cfg, auth, audit, files, gitWrite, agents, attachments, claudeSettings, claudeLogin, workspaces, registry, watcher, live } = deps;

  // The body limit must clear the write cap AFTER base64 expansion (~1.37x), or a large binary save is
  // rejected by the body limit before the write-size check ever runs. No CORS: the only client is the
  // native app (bearer token in a header, not a browser), so CORS would be dead weight + surface.
  const bodyLimit = Math.max(cfg.bodyLimitBytes, Math.ceil(cfg.writeSizeCapBytes * 1.4));
  const app = Fastify({ bodyLimit, logger: false });

  // Tolerate an EMPTY body on `Content-Type: application/json`. Fastify's default parser rejects it,
  // which surfaced as a 500 on body-less writes (e.g. DELETE /v1/devices/:id) from any client that
  // sets the header globally — common, and not something a caller should have to work around.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body.trim() : "";
    if (text === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(badRequest("malformed JSON body"), undefined);
    }
  });

  // ---- auth on every request except the exempt endpoints --------------------
  app.addHook("onRequest", async (req) => {
    const url = req.url.split("?")[0] ?? req.url;
    if (AUTH_EXEMPT.has(url)) return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    const device = auth.authenticate(token);
    if (!device) throw unauthorized();
    req.device = device;
  });

  // ---- uniform error translation -------------------------------------------
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof BridgeError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if ((err as { statusCode?: number }).statusCode === 413) {
      return reply.code(413).send({ error: { code: "too_large", message: "request body too large" } });
    }
    return reply.code(500).send({ error: { code: "internal", message: (err as Error).message } });
  });

  // Repos resolve through the shared `registry` (config repos + served workspaces; see RepoRegistry). This
  // is the SAME instance the live/chat channel uses, so an opened workspace gets files, git, AND chat.
  const repo = (req: FastifyRequest): RepoConfig => {
    const id = (req.params as { repo: string }).repo;
    const r = registry.byId(id);
    if (!r) throw notFound(`repo not found: ${id}`);
    return r;
  };
  const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;

  const requireWorkspaces = () => {
    if (!cfg.workspacesEnabled) throw notFound("workspaces feature is not enabled");
  };

  // ---- meta -----------------------------------------------------------------
  app.get("/v1/health", async () => ({
    ok: true, protocol: PROTOCOL_VERSION, bridge: BRIDGE_VERSION,
    features: { workspaces: cfg.workspacesEnabled, terminal: cfg.terminal.enabled },
  }));

  app.post("/v1/pair", async (req) => {
    const body = req.body as { code?: string; label?: string } | undefined;
    // `label` is optional so an older app still pairs — it just lands as the default "device".
    return { token: await auth.pair(body?.code ?? "", body?.label) };
  });

  // ---- paired devices (ADR-035) --------------------------------------------
  // `connected` comes from the LIVE set, not lastSeenAt — with several devices you want to know who
  // is on the socket right now, not who called REST most recently.
  app.get("/v1/devices", async () => {
    const online = live.connectedDeviceIds();
    return { devices: auth.list().map((d) => ({ ...d, connected: online.has(d.id) })) };
  });

  app.delete<{ Params: { id: string } }>("/v1/devices/:id", async (req, reply) => {
    const { id } = req.params;
    // Refuse self-revocation: it would kill the very connection issuing the request, and the app
    // would be left unable to show the result. Un-pair from the device itself instead.
    if (req.device?.id === id) throw forbidden("cannot revoke the device making this request");
    if ((await auth.revoke(id)) === 0) throw notFound(`unknown device: ${id}`);
    // Revocation must be IMMEDIATE: an open WS authenticates once at connect, so without this the
    // revoked device would keep streaming events (and keep its shells) until it disconnected.
    const dropped = live.disconnectDevice(id);
    await audit.record({
      actor: "app", device: req.device?.id, repo: "-", action: "device.revoke", target: id, ok: true,
      detail: `closed ${dropped} live connection(s)`,
    });
    return reply.code(200).send({ ok: true, revoked: id, connectionsClosed: dropped });
  });

  app.get("/v1/repos", async () => ({
    // A config repo is never removable; an opened workspace (absent from config) is.
    repos: await Promise.all(registry.list().map((r) => repoSummary(r, !cfg.repoById(r.id)))),
  }));

  // ---- host filesystem browse + open-as-workspace (behind the Bearer gate) --
  app.get("/v1/fs/roots", async () => {
    requireWorkspaces();
    return { roots: fsBrowse.roots(cfg) };
  });

  app.get("/v1/fs/list", async (req) => {
    requireWorkspaces();
    const { root, path } = q(req);
    if (!root) throw notFound("root is required");
    return fsBrowse.list(cfg, root, path ?? "");
  });

  app.post("/v1/fs/mkdir", async (req) => {
    requireWorkspaces();
    const body = req.body as { root: string; path?: string; name: string };
    return fsBrowse.mkdir(cfg, body.root, body.path ?? "", body.name);
  });

  app.post("/v1/workspaces/open", async (req) => {
    requireWorkspaces();
    const body = req.body as OpenWorkspaceBody;
    const root = cfg.rootById(body.root);
    if (!root) throw notFound(`root not found: ${body.root}`);
    const abs = await confine(root.path, body.path ?? "");

    // Idempotent: re-opening an already-registered folder returns its existing summary. Compare realpaths
    // (abs is already realpath'd by confine; config-repo paths are only expandPath'd) so a symlink-aliased
    // config repo isn't duplicated as a second workspace.
    const already = (
      await Promise.all(
        registry.list().map(async (r) => [r, await realpath(r.path).catch(() => r.path)] as const),
      )
    ).find(([, rp]) => rp === abs)?.[0];
    if (already) return { repo: await repoSummary(already, !cfg.repoById(already.id)) };

    let isRepo = await stat(join(abs, ".git")).then(() => true, () => false);
    if (!isRepo) {
      if (!body.initGit) return { needsInit: true, path: body.path ?? "" };
      await gitWrite.initRepo(abs);
      isRepo = true;
    }

    const id = uniqueId(basename(abs), cfg, workspaces);
    const provider = body.provider ?? cfg.claude.defaultProvider;
    const profile = body.profile ?? cfg.claude.defaultProfile;
    await workspaces.add({ id, path: abs, provider, profile, openedAt: new Date().toISOString() });
    registry.markServed(id); // just confined to a current root, so it's served immediately (and after restart)
    const r = asRepoConfig({ id, path: abs, provider, profile });
    watcher.watch(r);              // live working-tree/git-state pushes for the new workspace
    live.broadcastRepoChanged(id, []); // nudge connected apps to refresh their repo list
    return { repo: await repoSummary(r, true) }; // an opened workspace is always removable
  });

  // Un-register an opened workspace (workspaces.json only — NEVER touches the folder/files on disk).
  app.delete("/v1/workspaces/:id", async (req) => {
    requireWorkspaces();
    const id = (req.params as { id: string }).id;
    if (cfg.repoById(id)) throw forbidden("cannot remove a config repo");
    if (!workspaces.byId(id)) throw notFound(`workspace not found: ${id}`);
    await workspaces.remove(id);
    registry.unserve(id);
    await watcher.unwatch(id);
    live.broadcastRepoChanged(id, []); // nudge connected apps to refresh their repo list
    return { ok: true };
  });

  // ---- read -----------------------------------------------------------------
  app.get("/v1/repos/:repo/refs", async (req) => gitSvc.getRefs(repo(req).path));

  app.get("/v1/repos/:repo/tree", async (req, reply) => {
    const r = repo(req); const { ref, path } = q(req);
    const resolved = await gitSvc.resolveRef(r.path, ref);
    setCache(reply, resolved);
    return gitSvc.listTree(r.path, resolved, path ?? "");
  });

  app.get("/v1/repos/:repo/blob", async (req, reply) => {
    const r = repo(req); const { ref, path } = q(req);
    if (!path) throw notFound("path is required");
    const resolved = await gitSvc.resolveRef(r.path, ref);
    setCache(reply, resolved);
    return gitSvc.readBlob(r.path, resolved, path);
  });

  app.get("/v1/repos/:repo/log", async (req) => {
    const r = repo(req); const { ref, path, limit } = q(req);
    const resolved = await gitSvc.resolveRef(r.path, ref);
    return { commits: await gitSvc.log(r.path, resolved, path, Number(limit ?? 50)) };
  });

  app.get("/v1/repos/:repo/diff", async (req) => {
    const r = repo(req); const { kind, ref, path } = q(req);
    return { diff: await gitSvc.diff(r.path, (kind ?? "worktree") as DiffKind, ref ?? WORKTREE, path) };
  });

  /**
   * KiCad schematic scene (ADR-038, Phase 1).
   *
   * `path` is the design's **root** sheet; `sheet` selects which instance to draw and defaults to the
   * root. The response carries every drawable already tagged with its net/ref, plus the sibling sheet
   * list so the app's sheet switcher needs no second request.
   *
   * Sheets are read as **git blobs** through `readBlob`, which confines each path (realpath, symlink
   * aware). `loadDesign` independently refuses to follow a `Sheetfile` outside the root sheet's
   * directory — this is the first place the parser meets repository content, so both checks stay.
   */
  /**
   * The other half of a KiCad project, if it is there.
   *
   * A `.kicad_sch` and its `.kicad_pcb` pair by directory + basename. The *app* must not work that out for
   * itself: only the bridge can tell whether the sibling actually exists at this ref, and an app that
   * guesses would offer a "show on board" action that 404s on any project naming its files differently.
   * Absent when there is no counterpart, so the action simply is not offered.
   */
  const counterpartOf = async (repoPath: string, resolved: string, path: string): Promise<string | undefined> => {
    const other = counterpartPath(path);
    if (!other) return undefined;
    return (await gitSvc.blobExists(repoPath, resolved, other)) ? other : undefined;
  };

  /**
   * What this KiCad project contains, at this ref (ADR-040).
   *
   * Takes any of the three project files and answers with the ones that exist, so the app can open a
   * *design* — tabs decided by what is actually there rather than a fixed `schematic | pcb | 3D` triple,
   * which would show a dead tab on more than half the corpus (18 of 36 projects are schematic-only).
   *
   * **Naming and existence only — nothing is parsed.** Opening a project must not cost what opening its
   * board costs; `vme-wren` is 66 MB and 3.9 s to parse, and the tabs are a routing question. The scene
   * and board index are still fetched per tab, on demand.
   *
   * A **sub-sheet** (`muxdata.kicad_sch` inside the `video` project) pairs with nothing by name, so it
   * falls back to the `.kicad_pro` files beside it — and refuses when there is more than one, which the
   * corpus contains (`ecc83/`). `unresolved` says which case it was, because "this design has no project
   * file" and "we found several and will not guess" are different answers to the user.
   */
  app.get("/v1/repos/:repo/kicad/project", async (req, reply) => {
    const r = repo(req);
    const { ref, path: rawPath } = q(req);
    if (!rawPath) throw notFound("path is required");
    // Normalised before anything looks at it. Un-normalised input made the endpoint answer differently
    // depending on the ref — `video/libs/../video.kicad_sch` resolved at the working tree (echoing the
    // `..` back inside every path the app would then re-request) and 404'd at a commit, because
    // `git rev-parse ref:a/../b` does not collapse the way a filesystem does. Same design, two answers.
    const path = normalizePosix(rawPath);
    if (path.startsWith("../") || path === "..") throw badRequest(`path escapes the repository: ${rawPath}`);
    const named = projectBasename(path);
    if (!named) throw badRequest(`not a KiCad project file: ${path}`);
    const resolved = await gitSvc.resolveRef(r.path, ref);
    setCache(reply, resolved);

    const has = async (p: string): Promise<string | undefined> =>
      (await gitSvc.blobExists(r.path, resolved, p)) ? p : undefined;

    /**
     * The three files for one stem.
     *
     * Each half is probed in the canonical lowercase spelling **and** in fully upper case, because
     * `projectPaths` only emits the former while git paths are case-sensitive. Repairing only the
     * *requested* file was not enough: a `Proj.KICAD_SCH` beside `Proj.KICAD_PRO` and `Proj.KICAD_PCB`
     * came back with no schematic and no board, so the file the user opened was reported as a sub-sheet
     * of a project with no root sheet and no PCB tab. Two probes per half, and only for a stem we are
     * already committed to.
     *
     * Deliberately those two spellings and no more. A mixed spelling like `Design.Kicad_Pcb` is not
     * found, and the honest reason is cost: the general fix is a directory listing per request, on a
     * route whose whole point is three cheap existence checks. The two that are probed are the two that
     * occur — the corpus has 22 fully-upper `.STEP` references and no mixed ones, because they come out
     * of tools rather than out of typing.
     */
    const halvesOf = async (parts: ProjectParts) => {
      const cand = projectPaths(parts.base);
      const either = async (p: string): Promise<string | undefined> => {
        const dot = p.lastIndexOf(".");
        const upper = p.slice(0, dot) + p.slice(dot).toUpperCase();
        return (await has(p)) ?? (upper === p ? undefined : await has(upper));
      };
      const [project, schematic, board] = await Promise.all([
        either(cand.project), either(cand.schematic), either(cand.board),
      ]);
      return { project, schematic, board };
    };

    const [requestedExists, firstPass] = await Promise.all([
      gitSvc.blobExists(r.path, resolved, path),
      halvesOf(named),
    ]);

    // Before anything expensive. `describeProject` reports `{missing:true}` for a file that is not
    // there, but only after the sub-sheet fallback has already paid for a `listTree` AND a whole
    // schematic `readBlob` — on the way to a 404, from a route whose docstring promises naming and
    // existence only.
    if (!requestedExists) throw notFound(`no KiCad project file at ${path}`);

    let parts = named;
    let present = firstPass;
    let unresolved: UnresolvedReason | undefined;
    /** True once `parts`/`present` describe a project the requested file does not share a stem with. */
    let viaSibling = false;
    /** Whether the sheet was confirmed to be in the resolved project's hierarchy — see below. */
    let membership: "verified" | "assumed" = "assumed";

    // **Only a schematic can be a sub-sheet.** A KiCad project has one board, named for the project, so
    // a `.kicad_pcb` that pairs with no `.kicad_pro` is a board without a project file — not a member of
    // some other project. Running the fallback for it re-derived `present` from the *sibling* project's
    // stem and threw away the board the client actually asked about: with `video/other.kicad_pcb` beside
    // `video/video.kicad_pro`, the answer named `video/video.kicad_pcb` and never mentioned the
    // requested file, so the app would open the wrong board.
    // **And only when the sheet's own stem paired with nothing at all.** `!present.project` alone was not
    // enough: a second design in the same directory — `alt.kicad_sch` + `alt.kicad_pcb` beside
    // `main.kicad_pro`, which is what you get when only one board is "the project" — has no `.kicad_pro`
    // of its own, so it fell through and was answered with *main's* board while its own, pairing by name,
    // went unmentioned. The app would open main's PCB for someone who tapped alt's schematic. A stem that
    // already has a board is a design in its own right.
    if (!present.project && !present.board && path.toLowerCase().endsWith(".kicad_sch")) {
      // Only now is a directory listing worth its cost — the sub-sheet case, since `muxdata.kicad_sch`
      // pairs with nothing by name.
      const dir = named.base.includes("/") ? named.base.slice(0, named.base.lastIndexOf("/")) : "";
      const siblings = await gitSvc.listTree(r.path, resolved, dir)
        // Case-insensitively, like every other extension test on this route. Matching only the lowercase
        // spelling here meant a sub-sheet beside a `Proj.KICAD_PRO` reported `no-project-file` and lost
        // its project, board and root-sheet tabs — the same defect the direct-path case already fixed,
        // reached by the sibling route instead.
        .then((t) => t.entries.filter((e) => e.type === "blob" && e.name.toLowerCase().endsWith(".kicad_pro"))
          .map((e) => (dir ? `${dir}/${e.name}` : e.name)))
        // A directory we cannot list is not an error here — it just means no project was found beside it.
        .catch(() => [] as string[]);
      let found = projectForSheet(siblings);
      // A sub-sheet may live one level DOWN from its project. `royalblue54L_feather/` keeps four of them
      // in `sch/`, and the root sheet names them `"sch/nRF54L15.kicad_sch"` — so looking only in the
      // sheet's own directory reported no project at all and the PCB tab vanished for a sheet whose
      // project is demonstrably one directory up. Searching the parent is only safe *because* the
      // membership check below can confirm it; an unverified parent match is discarded rather than
      // guessed at, which a same-directory match does not have to be.
      let fromParent = false;
      if (!("project" in found) && dir.includes("/")) {
        const up = dir.slice(0, dir.lastIndexOf("/"));
        const upSiblings = await gitSvc.listTree(r.path, resolved, up)
          .then((t) => t.entries
            .filter((e) => e.type === "blob" && e.name.toLowerCase().endsWith(".kicad_pro"))
            .map((e) => (up ? `${up}/${e.name}` : e.name)))
          .catch(() => [] as string[]);
        const upFound = projectForSheet(upSiblings);
        if ("project" in upFound) { found = upFound; fromParent = true; }
      }

      // **Does the project actually contain this sheet?** `projectForSheet` answers a question about a
      // *directory* — "exactly one .kicad_pro sits here" — which is not membership. A directory holding
      // `main.kicad_pro`/`main.kicad_sch`/`main.kicad_pcb` plus an unrelated `scratch.kicad_sch` would
      // hand `scratch` the whole of `main`, and the app would open main's PCB for a file that is not
      // part of it — the "opening the wrong project's viewer is worse than offering nothing" outcome the
      // ambiguity refusal exists to prevent.
      //
      // Checked by reading the project's ROOT sheet for a `Sheetfile` naming this file. One blob, on a
      // path already listing a directory.
      if ("project" in found) {
        const projBase = projectBasename(found.project)?.base ?? "";
        const rootSheet = `${projBase}.kicad_sch`;
        // Relative to the PROJECT's directory, not just the basename: a root sheet names a nested sheet
        // as `sch/nRF54L15.kicad_sch`, so matching the basename alone would miss exactly the case the
        // parent search exists for.
        const projDir = projBase.includes("/") ? projBase.slice(0, projBase.lastIndexOf("/") + 1) : "";
        const wanted = path.startsWith(projDir) ? path.slice(projDir.length) : path.slice(path.lastIndexOf("/") + 1);
        membership = await gitSvc.readBlob(r.path, resolved, rootSheet)
          .then((b) => {
            const text = b.encoding === "base64"
              ? Buffer.from(b.content, "base64").toString("utf-8") : b.content;
            return text.includes(`"Sheetfile" "${wanted}"`) ? "verified" as const : "assumed" as const;
          })
          .catch(() => "assumed" as const);
      }

      // A parent-directory project is accepted only on proof; a same-directory one keeps the weaker
      // rule, because that is the shape the corpus is full of. A sheet nested deeper than the root sheet
      // names is a false negative here — it loses the parent match rather than being mis-assigned.
      if (fromParent && membership !== "verified") found = { reason: "no-project-file" };

      if ("project" in found) {
        // **Re-derive the halves from the PROJECT's stem, not the sheet's.** Skipping this was a real
        // bug: opening `video/muxdata.kicad_sch` reported no board, because it had looked for
        // `video/muxdata.kicad_pcb` — while `video/video.kicad_pcb`, named by the very project in the
        // same response, sat right there. Every sub-sheet lost its PCB tab; `vme-wren` has 36.
        const viaProject = projectBasename(found.project);
        if (viaProject) {
          parts = viaProject;
          // `halvesOf` goes through `projectPaths`, which only emits the canonical lowercase spelling —
          // so a `Proj.KICAD_PRO` the scan just found would be dropped again one line later. Keep the
          // path the scan actually saw; it is the one that exists.
          present = { ...(await halvesOf(viaProject)), project: found.project };
          viaSibling = true;
        }
      } else {
        unresolved = found.reason;
      }
    }

    // A file whose extension is not lowercase still exists, and `projectPaths` only ever emits the
    // canonical spelling — so slot it in by hand rather than reporting a present file as absent.
    //
    // **Only for the requested file's OWN stem.** Once the halves come from a sibling project this must
    // not fire: a project with no `.kicad_sch` at its stem (project + board, sub-sheets named separately)
    // left `present.schematic` empty, so the sub-sheet was slotted in as the *root* sheet — and
    // `describeProject` then dropped `sheet`, because the requested file now equalled the schematic. The
    // app would be told the sub-sheet IS the design's root, losing the very distinction `sheet` exists
    // to carry.
    if (!viaSibling && requestedExists
        && path !== present.schematic && path !== present.board && path !== present.project) {
      const lower = path.toLowerCase();
      if (lower.endsWith(".kicad_sch") && !present.schematic) present = { ...present, schematic: path };
      if (lower.endsWith(".kicad_pcb") && !present.board) present = { ...present, board: path };
      // `.kicad_pro` too, which the first version of this missed: a `Foo.KICAD_PRO` that exists came back
      // with no `project` field, having paid for a directory listing on the way — and in a two-project
      // directory answered `ambiguous` about the very file the client had named.
      if (lower.endsWith(".kicad_pro") && !present.project) present = { ...present, project: path };
    }

    const view = describeProject({ requested: path, requestedExists, parts, present, unresolved });
    // Only meaningful when the project came from a sibling scan; a stem match is membership by definition.
    if (!("missing" in view) && viaSibling && membership === "assumed") view.sheetMembership = "assumed";
    // The client has to have named a file that is actually there — see [describeProject].
    if ("missing" in view) throw notFound(`no KiCad project file at ${path}`);
    return view;
  });

  app.get("/v1/repos/:repo/kicad/scene", async (req, reply) => {
    const r = repo(req);
    const { ref, path: rawScenePath, sheet } = q(req);
    if (!rawScenePath) throw notFound("path is required");
    // Normalised like `/kicad/project`, `/kicad/board` and `/kicad/model`. Left out of that sweep, this
    // was the last route where `video/libs/../video.kicad_sch` answered 200 in the worktree and 404 at a
    // ref — the "same design, two answers" defect, still live one route over from the comment describing
    // it.
    const path = normalizePosix(rawScenePath);
    const resolved = await gitSvc.resolveRef(r.path, ref);
    setCache(reply, resolved);
    // A file the client picked that is not a parseable schematic is a *client* error. Letting the parser's
    // exception escape produced HTTP 500 "internal", which says "the bridge is broken" about a perfectly
    // healthy bridge — and leaks a parser message to say it. Found by curling a `.kicad_pro`.
    const scene = await getScene({
      resolved,
      worktreeSentinel: WORKTREE,
      rootPath: path,
      instancePath: sheet,
      // A `.kicad_sch` is text, but `readBlob` base64-encodes anything it judges binary — a sheet with an
      // embedded file or an unusual encoding could trip that, and silently handing base64 to the parser
      // would look like a corrupt schematic rather than a decoding mistake.
      read: async (p) => {
        const blob = await gitSvc.readBlob(r.path, resolved, p);
        return blob.encoding === "base64" ? Buffer.from(blob.content, "base64").toString("utf-8") : blob.content;
      },
    }).catch((err: unknown) => {
      if (err instanceof BridgeError) throw err; // confinement / not-found already say the right thing
      // Only a genuine parse failure is the client's fault. Everything else — a dead `git`, an OOM, a
      // disk error — is ours, and must surface as a 500 rather than be dressed up as a bad request.
      if (err instanceof SexprParseError) throw badRequest(`not a readable KiCad schematic: ${path}`);
      throw err;
    });
    return { ...scene, counterpart: await counterpartOf(r.path, resolved, path) };
  });

  /**
   * The board route (ADR-038, Phase 3). Two responses behind one path:
   *
   *  - **no `layer`** → the index: declared layers with their populations, components, nets, extent. No
   *    geometry, so it stays small even on an 81 MB board.
   *  - **`layer=F.Cu`** → that layer's drawables.
   *
   * One path rather than two because they answer the same question at different depths, and the client's
   * flow is always index-then-layer. The index is what makes the second call cheap to decide: it reports
   * that `User.9` holds 286,621 elements and `F.Cu` holds 20,887 *before* either is fetched.
   *
   * `zones=0` drops the copper pours. Fills are the bulk of a board and a caller that only wants routing
   * should not have to receive them.
   */
  app.get("/v1/repos/:repo/kicad/board", async (req, reply) => {
    const r = repo(req);
    const { ref, path: rawBoardPath, layer, zones } = q(req);
    if (!rawBoardPath) throw notFound("path is required");
    // Normalised for the same reason the project route is, and now with more at stake: this string is
    // the identity of a *build* and of a manifest. `video/video.kicad_pcb` and `video/./video.kicad_pcb`
    // both confine, both parse the same board, and both used to produce different `inflight` keys and
    // different manifest hashes — so the in-flight join and the cooldown were bypassed and two
    // converters ran over the same 66 models, each writing its own manifest.
    const path = normalizePosix(rawBoardPath);
    const resolved = await gitSvc.resolveRef(r.path, ref);
    setCache(reply, resolved);

    const request = {
      resolved,
      worktreeSentinel: WORKTREE,
      path,
      // A `.kicad_pcb` is text, but `readBlob` base64-encodes anything it judges binary. Handing base64
      // to the parser would look like a corrupt board rather than a decoding mistake — the same trap the
      // schematic route documents.
      read: async (p: string) => {
        const blob = await gitSvc.readBlob(r.path, resolved, p);
        return blob.encoding === "base64" ? Buffer.from(blob.content, "base64").toString("utf-8") : blob.content;
      },
    };

    // Only a genuine parse failure is the client's fault — curling a `.kicad_pro` is a 400, not a 500 that
    // says "the bridge is broken" about a healthy bridge and leaks a parser message to say it.
    const fail = (err: unknown): never => {
      if (err instanceof BridgeError) throw err;
      if (err instanceof SexprParseError) throw badRequest(`not a readable KiCad board: ${path}`);
      throw err;
    };

    if (!layer) {
      const index = await getBoardIndex(request, cfg.kicadModelVars).catch(fail);
      // Resolve the model references against this host. Deliberately here rather than in the reader: the
      // reader stays pure and testable without a disk, and only the bridge knows the operator's mapping.
      //
      // `projectDir` is the board's directory in the *working tree*, which is what `${KIPRJMOD}` and
      // relative references mean. Note it is the working tree even when reading an older ref — model
      // files rarely move, and the alternative is materialising them out of git to answer a coverage
      // question.
      const manifest = cfg.kicadMeshCache
        ? await getManifest(cfg.kicadMeshCache, r.id, path)
        : undefined;
      const models = {
        ...index.models,
        resolved: resolveAll(index.models.paths, {
          modelPaths: cfg.kicadModelPaths,
          projectDir: join(r.path, dirname(path)),
          embedded: new Set(index.models.embedded),
        }),
        // What of that is actually renderable — read from the manifest `gitview-models` left behind, not
        // recomputed. Absent cache, absent manifest and unbuilt board all report zeroes rather than
        // failing: a bridge without 3D is a normal bridge.
        meshes: meshCoverage(manifest),
        // Which models specifically, not just how many. The count answers "is 3D available at all";
        // a client deciding whether to offer a part needs to know about *that* part, and without this
        // it can only guess from a board-level number and open an empty viewer when it guesses wrong.
        readyModels: (manifest?.entries ?? []).filter((e) => e.key).map((e) => e.raw),
      };

      // Only on the index. A layer response is fetched repeatedly as chips are toggled, and the answer
      // cannot change between them — one `rev-parse` per layer would be pure waste.
      return { ...index, models, counterpart: await counterpartOf(r.path, resolved, path) };
    }
    return await getBoardLayer(request, layer, { includeZones: zones !== "0" }).catch(fail);
  });

  /**
   * A converted 3D model, by the reference the board writes.
   *
   * Serving only — the bridge has no CAD kernel and never converts. `gitview-models` built whatever is
   * here ahead of time; see ADR-038 Phase 4a for why that split exists (a 25 MB STEP costs 101 s and
   * 1.7 GB of RSS to tessellate, which is not something a request may do).
   *
   * `model` is the raw reference and is attacker-controlled, so it is used purely as a lookup key in the
   * board's manifest. The path served is derived from the manifest's own hash, and only after it is
   * confirmed to *be* a hash — see `meshFor`.
   */
  app.get("/v1/repos/:repo/kicad/model", async (req, reply) => {
    const r = repo(req);
    const { path: rawModelBoard, model } = q(req);
    if (!rawModelBoard) throw notFound("path is required");
    // Normalised to match `/kicad/board`. Both hash this string into `manifestPath`, so normalising only
    // one of them made them disagree: an index fetched as `hw/./main.kicad_pcb` builds and writes a
    // manifest under `hw/main.kicad_pcb`, and then every mesh request at that same spelling missed the
    // manifest and 404'd. Before the board route normalised, both used the raw string and agreed.
    const path = normalizePosix(rawModelBoard);
    if (!model) throw notFound("model is required");
    if (!cfg.kicadMeshCache) throw notFound("no mesh cache is configured on this bridge");

    const found = meshFor(await getManifest(cfg.kicadMeshCache, r.id, path), model);
    if (!found.ok) {
      // Deliberately specific. "There is no mesh" has four causes and only some are worth acting on:
      // nobody ran the converter, this board does not use that model, it is known but could not be
      // built (the manifest says why), or the manifest is not trustworthy.
      throw notFound(
        found.reason === "not-built" ? `no meshes have been built for ${path}`
        : found.reason === "unknown-model" ? "that model is not referenced by this board"
        : found.reason === "bad-key" ? "the manifest for this board is not usable"
        : `no mesh for that model: ${found.failure ?? "not built"}`,
      );
    }

    const blob = blobPath(cfg.kicadMeshCache, found.key);
    let bytes: Buffer;
    try {
      bytes = await readFile(blob);
    } catch {
      // The manifest names a blob that is not there — a half-copied cache, or one pruned underneath us.
      // Reported as absent rather than as a server fault, because the bridge is fine and the fix is to
      // re-run the converter.
      throw notFound("that mesh is named by the manifest but missing from the cache");
    }
    // Content-addressed, so it can never change under this URL.
    reply.header("cache-control", "public, max-age=31536000, immutable");
    reply.header("content-type", "model/gltf-binary");
    return reply.send(bytes);
  });


  app.get("/v1/repos/:repo/blame", async (req) => {
    const r = repo(req); const { ref, path } = q(req);
    if (!path) throw notFound("path is required");
    return { blame: await gitSvc.blame(r.path, await gitSvc.resolveRef(r.path, ref), path) };
  });

  app.get("/v1/repos/:repo/show", async (req) => {
    const r = repo(req); const { ref } = q(req);
    return { show: await gitSvc.show(r.path, ref ?? "HEAD") };
  });

  app.get("/v1/repos/:repo/status", async (req) => ({ status: await gitSvc.status(repo(req).path) }));

  // ---- write (working tree only; historical refs are read-only) -------------
  const assertWorktree = (req: FastifyRequest) => {
    const ref = q(req)["ref"];
    if (ref && ref !== WORKTREE) throw readOnly();
  };

  app.put("/v1/repos/:repo/file", async (req) => {
    assertWorktree(req);
    const r = repo(req); const path = q(req)["path"];
    if (!path) throw notFound("path is required");
    const body = req.body as SaveFileBody;
    return files.save(r.id, r.path, path, body.content, body.encoding, "app");
  });

  app.post("/v1/repos/:repo/file", async (req) => {
    const r = repo(req); const body = req.body as CreateFileBody;
    return files.create(r.id, r.path, body.path, body.content, body.encoding, "app");
  });

  app.delete("/v1/repos/:repo/file", async (req) => {
    const r = repo(req); const path = q(req)["path"];
    if (!path) throw notFound("path is required");
    return files.remove(r.id, r.path, path, "app");
  });

  app.post("/v1/repos/:repo/rename", async (req) => {
    const r = repo(req); const body = req.body as RenameBody;
    return files.renamePath(r.id, r.path, body.from, body.to, "app");
  });

  app.post("/v1/repos/:repo/stage", async (req) => {
    const r = repo(req); const body = req.body as StageBody;
    return gitWrite.stage(r.id, r.path, body.paths, "app");
  });

  app.post("/v1/repos/:repo/commit", async (req) => {
    const r = repo(req); const body = req.body as CommitBody;
    return gitWrite.commit(r.id, r.path, body.message, body.paths, "app");
  });

  app.post("/v1/repos/:repo/discard", async (req) => {
    const r = repo(req); const body = req.body as StageBody;
    return gitWrite.discard(r.id, r.path, body.paths, "app");
  });

  app.post("/v1/repos/:repo/checkout", async (req) => {
    const r = repo(req); const body = req.body as CheckoutBody;
    return gitWrite.checkout(r.id, r.path, body.ref, body.create ?? false, "app");
  });

  app.post("/v1/repos/:repo/push", async (req) => {
    const r = repo(req); const body = (req.body ?? {}) as PushBody;
    return gitWrite.push(r.id, r.path, body.remote, body.branch, body.setUpstream ?? false, "app");
  });

  // ---- claude settings (model + in-app credential) --------------------------
  // The status object shared by GET + PUT. Never contains the raw secret (only a masked hint).
  const claudeStatus = (): ClaudeSettingsResponse => ({
    model: claudeSettings.model,
    configModel: cfg.claude.model,
    effort: claudeSettings.effort ?? null,
    configEffort: cfg.claude.effort ?? null,
    auth: claudeSettings.authMode,
    hint: claudeSettings.hint,
    host: {
      credentials: existsSync(join(homedir(), ".claude", ".credentials.json")),
      apiKeyEnv: !!process.env["ANTHROPIC_API_KEY"],
    },
  });

  app.get("/v1/claude/settings", async () => claudeStatus());

  app.put("/v1/claude/settings", async (req) => {
    const body = (req.body ?? {}) as PutClaudeSettingsBody;

    // model: only touched when the key is present. "" (or blank) resets to the config default;
    // a non-empty string sets the runtime override.
    if (body.model !== undefined) await claudeSettings.setModel(body.model);

    // effort: same contract as model — present-key-only, "" resets to the config default. An unknown
    // level is rejected HERE (400) rather than reaching the SDK, where it would fail the next query.
    if (body.effort !== undefined) {
      try {
        await claudeSettings.setEffort(body.effort);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    }

    // auth: mode "host" clears any stored credential; "api-key"/"subscription" store a non-empty secret.
    if (body.auth) {
      if (body.auth.mode === "host") {
        await claudeSettings.clearAuth();
      } else if (body.auth.mode === "api-key" || body.auth.mode === "subscription") {
        const secret = body.auth.secret ?? "";
        if (!secret) throw badRequest("auth.secret is required for api-key/subscription");
        await claudeSettings.setAuth(body.auth.mode, secret);
      }
    }

    // Audit the write — target records the effective model + auth MODE only, NEVER the secret.
    await audit.record({
      actor: "app",
      repo: "-",
      action: "claude.settings",
      // Record the effective effort too, so the audit trail shows the whole agent configuration a
      // change produced (it was silently absent while only model/auth were logged).
      target: `model=${claudeSettings.model} effort=${claudeSettings.effort ?? "default"} auth=${claudeSettings.authMode}`,
      ok: true,
    });
    return claudeStatus();
  });

  // ---- claude subscription login (drives `claude setup-token` in a PTY) ------
  // Bearer-gated (NOT auth-exempt). The pasted code and any captured token NEVER appear in a response,
  // a log line, or an audit target — audit records the action + coarse status only.
  app.post("/v1/claude/login/start", async (_req, reply) => {
    await audit.record({ actor: "app", repo: "-", action: "claude.login.start", target: "-", ok: true });
    try {
      return await claudeLogin.start();
    } catch (err) {
      // These map to a PLAIN { error: "..." } body (per the wire contract), not the BridgeError shape.
      if (err instanceof NoPtyError) return reply.code(500).send({ error: "no_pty" });
      if (err instanceof NoUrlError) return reply.code(500).send({ error: "no_url" });
      throw err;
    }
  });

  app.post("/v1/claude/login/submit", async (req) => {
    const body = (req.body ?? {}) as ClaudeLoginSubmitBody;
    const result = await claudeLogin.submit(body.loginId ?? "", body.code ?? "");
    // target is the RESULT STATUS ("ok"/"error") — never the code or token.
    await audit.record({ actor: "app", repo: "-", action: "claude.login.submit", target: result.status, ok: result.status === "ok" });
    return result;
  });

  app.post("/v1/claude/login/cancel", async (req) => {
    const body = (req.body ?? {}) as { loginId?: string };
    claudeLogin.cancel(body.loginId ?? "");
    return { ok: true };
  });

  // ---- agents (chat providers) ----------------------------------------------
  // The app reads this to populate its agent switcher; each agent's `capabilities` tell it which
  // provider-specific controls (model pin / in-app login) to show.
  app.get("/v1/agents", async () => ({ agents: agents.list() }));

  // Serve a file the agent attached to the chat (auth-gated like everything else; the app fetches with its
  // bearer token, then renders inline or saves).
  app.get("/v1/attachments/:id", async (req, reply) => {
    const att = await attachments.read((req.params as { id: string }).id);
    if (!att) throw notFound("attachment not found");
    reply.header("Content-Type", att.mime);
    reply.header("Content-Disposition", `inline; filename="${att.name.replace(/["\r\n]/g, "")}"`);
    return reply.send(att.bytes);
  });

  // ---- sessions -------------------------------------------------------------
  // Sessions are per-agent (Claude/Codex store them separately), so every session route resolves the
  // agent from `?agent=` (falling back to the bridge default).
  const agentFor = (req: FastifyRequest) => agents.get((req.query as { agent?: string }).agent);

  app.get("/v1/repos/:repo/sessions", async (req) => ({
    sessions: await agentFor(req).listForRepo(repo(req)),
  }));

  app.get("/v1/repos/:repo/sessions/:id/messages", async (req) =>
    agentFor(req).messagesForRepo(repo(req), (req.params as { id: string }).id),
  );

  app.delete("/v1/repos/:repo/sessions/:id", async (req) => {
    const r = repo(req);
    const id = (req.params as { id: string }).id;
    await agentFor(req).deleteForRepo(r, id);
    await audit.record({ actor: "app", repo: r.id, action: "session.delete", target: id, ok: true });
    return { ok: true };
  });

  app.post("/v1/repos/:repo/sessions", async (req) => {
    const body = req.body as StartSessionBody;
    // Chat is always local-sdk: the actual prompt/stream happens over the WebSocket; here we just acknowledge.
    return { sessionId: body.resume ?? "pending", provider: "local-sdk" as const };
  });

  return app;
}

/** Immutable object ids get a strong ETag + long cache; the working tree is never cached. */
function setCache(reply: FastifyReply, resolved: string): void {
  if (resolved === WORKTREE) {
    reply.header("Cache-Control", "no-cache");
  } else {
    reply.header("ETag", `"${resolved}"`);
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
  }
}

/** A filename-safe workspace id from a folder basename, unique across config repos + open workspaces. */
function uniqueId(base: string, cfg: Config, workspaces: WorkspaceStore): string {
  const taken = new Set<string>([...cfg.repos.map((r) => r.id), ...workspaces.list().map((w) => w.id)]);
  const slug = slugifyId(base);
  let id = slug;
  let n = 2;
  while (taken.has(id)) id = `${slug}-${n++}`;
  return id;
}

// keep tooLarge referenced for future streaming-write use
void tooLarge;
