import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/http/rest.js";
import type { Config } from "../src/config.js";
import { AuthManager } from "../src/auth/pairing.js";
import { AuditLog } from "../src/util/audit.js";
import { FileService } from "../src/git/fileService.js";
import { GitWrite } from "../src/git/gitWrite.js";
import { ClaudeSettingsStore } from "../src/claude/settingsStore.js";
import { WorkspaceStore } from "../src/workspaces/store.js";
import { RepoRegistry } from "../src/repoRegistry.js";
import { resetBuilder, builderDepth, drainBuilds } from "../src/kicad/meshBuilder.js";

/**
 * When the board index is allowed to start a conversion (ADR-040 Decision 5).
 *
 * Both rules here are about *not* spawning, and both were found by review rather than by use — which is
 * the point: a build that should not have started is invisible until a machine is busy for no reason.
 */

const exec = promisify(execFile);
const created: string[] = [];
const teardown: Array<() => Promise<void> | void> = [];
after(async () => {
  await Promise.all(teardown.map((f) => Promise.resolve(f()).catch(() => {})));
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});
// `drainBuilds()` FIRST, then reset. Resetting over live children was the same defect commit 03057e8
// fixed in production code: the stub converter's `finish()` then runs `running -= 1` against a counter
// that was just zeroed, driving it negative — after which the concurrency cap is off for the rest of the
// file. A test harness that reintroduces the bug it is testing for proves nothing.
beforeEach(async () => { await drainBuilds(); resetBuilder(); });

/** A board with one embedded model, so there is always something pending to build. */
const BOARD = `(kicad_pcb (version 20241229) (generator "t")
  (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (footprint "L:x" (layer "F.Cu") (at 1 1)
    (property "Reference" "U1") (property "Value" "v")
    (model "\${NOPE}/only.step" (offset (xyz 0 0 0)))))
`;

async function harness(opts: { converter?: string | null } = {}):
    Promise<{ app: FastifyInstance; token: string; cache: string; older: string; repoPath: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "gv-gate-"));
  const gv = await mkdtemp(join(tmpdir(), "gv-gate-gv-"));
  const cache = await mkdtemp(join(tmpdir(), "gv-gate-cache-"));
  const conv = await mkdtemp(join(tmpdir(), "gv-gate-conv-"));
  created.push(repoPath, gv, cache, conv);
  await mkdir(join(repoPath, "hw"), { recursive: true });
  await writeFile(join(repoPath, "hw", "main.kicad_pcb"), BOARD);
  // The model has to actually EXIST, or nothing is ever pending and the gate is untested for the reason
  // that matters. `${NOPE}` is mapped to the repo below, so this is where it resolves to.
  await writeFile(join(repoPath, "only.step"), "ISO-10303-21;\n");
  // A converter that exists and does nothing, so a spawn is observable without any CAD work.
  const converter = join(conv, "cli.js");
  await writeFile(converter, "process.exit(0);\n");

  await exec("git", ["init", "-q"], { cwd: repoPath });
  await exec("git", ["add", "-A"], { cwd: repoPath });
  await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"], { cwd: repoPath });
  // A second commit, so HEAD~1 is a genuinely historical ref rather than HEAD under another name.
  await writeFile(join(repoPath, "hw", "notes.txt"), "second\n");
  await exec("git", ["add", "-A"], { cwd: repoPath });
  await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "second"], { cwd: repoPath });
  // The FIRST commit's oid. `resolveRef` rejects `~` as ref injection (gitService.ts), so a historical
  // ref has to be named by its object id — which is also what the app sends.
  const older = (await exec("git", ["rev-parse", "HEAD~1"], { cwd: repoPath })).stdout.trim();

  const repos = [{ id: "fx", name: "fx", path: repoPath, provider: "local-sdk", profile: "auto" }];
  const cfg = {
    bind: "127.0.0.1", port: 0,
    tokensFile: join(gv, "tokens.json"), pairingCodeTtlMs: 600_000,
    workspacesFile: join(gv, "workspaces.json"),
    bodyLimitBytes: 8 << 20, writeSizeCapBytes: 4 << 20,
    auditFile: join(gv, "audit.log"),
    claude: { defaultProvider: "local-sdk", defaultProfile: "auto", sandbox: { enabled: false } },
    terminal: { enabled: false },
    claudeSettingsFile: join(gv, "claude-settings.json"),
    repos, repoById: (id: string) => repos.find((r) => r.id === id),
    workspaceRoots: [], workspacesEnabled: false, rootsList: () => [], rootById: () => undefined,
    // `${NOPE}` is mapped so the model RESOLVES — otherwise nothing is ever pending and the gate is
    // untested for the reason that matters.
    kicadModelPaths: { NOPE: repoPath }, kicadModelVars: new Set(["NOPE"]),
    kicadMeshCache: cache,
    kicadConverter: opts.converter === null ? "/nonexistent/none.js" : (opts.converter ?? converter),
    kicadConvertOnDemand: true,
  } as unknown as Config;

  const audit = new AuditLog(cfg.auditFile);
  const auth = new AuthManager(cfg.tokensFile);
  const token = await auth.pair(auth.currentPairingCode);
  const workspaces = new WorkspaceStore(cfg.workspacesFile);
  await workspaces.load();
  const app = await buildServer({
    cfg, auth, audit,
    files: new FileService(cfg.writeSizeCapBytes, audit), gitWrite: new GitWrite(audit),
    workspaces, registry: new RepoRegistry(cfg, workspaces, new Set()),
    claudeSettings: new ClaudeSettingsStore(cfg.claudeSettingsFile, "claude-opus-4-8"),
    watcher: { close: () => {} }, live: { connectedDeviceIds: () => new Set() },
  } as never);
  teardown.push(() => app.close());
  return { app, token, cache, older, repoPath };
}

const index = (app: FastifyInstance, token: string, path: string, ref?: string) =>
  app.inject({
    method: "GET",
    url: `/v1/repos/fx/kicad/board?path=${encodeURIComponent(path)}${ref ? `&ref=${ref}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

test("the working tree may start a build", async () => {
  const { app, token } = await harness();
  const res = await index(app, token, "hw/main.kicad_pcb");
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { models: { building?: string } }).models.building, "running");
});

test("a ref that IS the checked-out HEAD may build", async () => {
  // `resolved === WORKTREE` only holds when the client omits `ref`, but the app puts a branch name in
  // `ui.ref` the moment the user touches the ref picker — so picking the checked-out branch silently
  // stopped conversion with nothing in the response to explain it. Those bytes are the working tree's.
  const { app, token } = await harness();
  const res = await index(app, token, "hw/main.kicad_pcb", "HEAD");
  assert.equal((res.json() as { models: { building?: string } }).models.building, "running");
});

test("a historical ref must NOT start a build", async () => {
  // The converter reads the WORKING TREE and the manifest is keyed by repo + board alone, so a build
  // triggered from an old ref can never converge on what that ref asked for. Left ungated it respawns
  // every cooldown, forever, at 1.7 GB peaks — and `stdio: "ignore"` swallows every complaint. Worse for
  // a board since renamed: the converter dies on `readFileSync` and is restarted once a minute for good.
  const { app, token, older } = await harness();
  const res = await index(app, token, "hw/main.kicad_pcb", older);
  assert.equal(res.statusCode, 200, "the index still answers at a ref");
  assert.equal((res.json() as { models: { building?: string } }).models.building, undefined,
    "no build is even attempted");
  assert.equal(builderDepth(), 0);
});

test("two spellings of one board are one build, not two", async () => {
  // The build key and the manifest key are this string. `hw/main.kicad_pcb` and `hw/./main.kicad_pcb`
  // both confine and both parse the same board, but un-normalised they produced different keys — so the
  // in-flight join and the cooldown were both bypassed and two converters ran over the same models,
  // each writing its own manifest.
  // Asserted on the STATE the second request reports, not on `builderDepth()`: the stub converter exits
  // in ~40-80 ms, so if it finishes between the two injects the key is already out of `inflight` and the
  // depth is 0 for a reason that has nothing to do with normalisation. Either way the second spelling
  // must be recognised as the same board — running/queued if the first is still going, cooling if it
  // just finished. What it must never be is a fresh build.
  const { app, token } = await harness();
  const first = await index(app, token, "hw/main.kicad_pcb");
  assert.equal((first.json() as { models: { building?: string } }).models.building, "running");
  const second = await index(app, token, "hw/./main.kicad_pcb");
  const state = (second.json() as { models: { building?: string } }).models.building;
  assert.ok(state === "running" || state === "cooling" || state === undefined,
    `the dotted spelling must resolve to the same board, got ${state}`);
  assert.ok(builderDepth() <= 1, "never two builds for one board");
});

test("a bridge with no converter SAYS so, rather than going quiet", async () => {
  // `buildable` short-circuited on `converter !== undefined`, so a bridge without one simply omitted
  // `models.building` — indistinguishable from "nothing to build". This is the state every packaged
  // bridge is in until the .deb ships a converter, and "no 3D, no reason given" is the worst version.
  const { app, token } = await harness({ converter: null });
  const res = await index(app, token, "hw/main.kicad_pcb");
  assert.equal((res.json() as { models: { building?: string } }).models.building, "unavailable");
});

test("a board missing from the working tree does not start a build", async () => {
  // `ref=HEAD` is treated as the working tree — but on a dirty tree the board may have been renamed or
  // deleted since, and the converter opens the WORKING TREE copy. Without this the gate spawns a
  // converter that dies on `readFileSync`: the historical-ref failure again, merely bounded.
  const { app, token, repoPath } = await harness();
  await rm(join(repoPath, "hw", "main.kicad_pcb"));
  const res = await index(app, token, "hw/main.kicad_pcb", "HEAD");
  assert.equal(res.statusCode, 200, "the board still reads from git at that ref");
  assert.equal((res.json() as { models: { building?: string } }).models.building, undefined,
    "but nothing is spawned for a file the converter cannot open");
});

test("the index is never stamped immutable", async () => {
  // `meshes`/`readyModels` move underneath a fixed commit oid — the manifest has no ref in its key — so
  // the strong ETag and the year-long max-age `setCache` applies to any non-worktree ref are both false
  // here. `no-cache` alone is not enough: revalidating an unchanged strong validator is a 304 with the
  // stale body, which pins a conditional-GET client exactly as hard.
  const { app, token, older } = await harness();
  const res = await index(app, token, "hw/main.kicad_pcb", older);
  assert.match(String(res.headers["cache-control"]), /no-cache/);
  assert.equal(res.headers["etag"], undefined, "and no strong validator to revalidate against");
});
