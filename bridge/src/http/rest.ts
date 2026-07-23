import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { slugifyId, type Config, type RepoConfig } from "../config.js";
import { RepoRegistry, asRepoConfig } from "../repoRegistry.js";
import type { AuthManager } from "../auth/pairing.js";
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

export async function buildServer(deps: RestDeps): Promise<FastifyInstance> {
  const { cfg, auth, audit, files, gitWrite, agents, attachments, claudeSettings, claudeLogin, workspaces, registry, watcher, live } = deps;

  // The body limit must clear the write cap AFTER base64 expansion (~1.37x), or a large binary save is
  // rejected by the body limit before the write-size check ever runs. No CORS: the only client is the
  // native app (bearer token in a header, not a browser), so CORS would be dead weight + surface.
  const bodyLimit = Math.max(cfg.bodyLimitBytes, Math.ceil(cfg.writeSizeCapBytes * 1.4));
  const app = Fastify({ bodyLimit, logger: false });

  // ---- auth on every request except the exempt endpoints --------------------
  app.addHook("onRequest", async (req) => {
    const url = req.url.split("?")[0] ?? req.url;
    if (AUTH_EXEMPT.has(url)) return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!auth.verify(token)) throw unauthorized();
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
    features: { workspaces: cfg.workspacesEnabled },
  }));

  app.post("/v1/pair", async (req) => {
    const code = (req.body as { code?: string })?.code ?? "";
    return { token: await auth.pair(code) };
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
      target: `model=${claudeSettings.model} auth=${claudeSettings.authMode}`,
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
