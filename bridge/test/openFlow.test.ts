import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/http/rest.js";
import { slugifyId, type Config, type WorkspaceRoot } from "../src/config.js";
import { AuthManager } from "../src/auth/pairing.js";
import { AuditLog } from "../src/util/audit.js";
import { FileService } from "../src/git/fileService.js";
import { GitWrite } from "../src/git/gitWrite.js";
import { SessionManager } from "../src/claude/sessionManager.js";
import { ClaudeSettingsStore } from "../src/claude/settingsStore.js";
import { LiveChannel } from "../src/ws/liveChannel.js";
import { RepoWatcher } from "../src/git/repoWatcher.js";
import { WorkspaceStore, servedWorkspaceIds } from "../src/workspaces/store.js";
import { RepoRegistry } from "../src/repoRegistry.js";

const exec = promisify(execFile);
const created: string[] = [];
const teardown: Array<() => Promise<void> | void> = [];
after(async () => {
  await Promise.all(teardown.map((f) => Promise.resolve(f()).catch(() => {})));
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

const claude = {
  defaultProvider: "local-sdk",
  defaultProfile: "auto",
  sandbox: { enabled: false, failIfUnavailable: false, denyRead: [], allowedDomains: [] },
} as unknown as Config["claude"];

function makeConfig(rootPath: string, gitviewDir: string): Config {
  const rl: WorkspaceRoot[] = [{ id: slugifyId(basename(rootPath)), path: rootPath, label: basename(rootPath) }];
  const repos: Config["repos"] = [];
  return {
    bind: "127.0.0.1", port: 0,
    tokensFile: join(gitviewDir, "tokens.json"),
    pairingCodeTtlMs: 600_000,
    workspacesFile: join(gitviewDir, "workspaces.json"),
    bodyLimitBytes: 10 * 1024 * 1024, writeSizeCapBytes: 8 * 1024 * 1024,
    auditFile: join(gitviewDir, "audit.log"),
    claude,
    terminal: { enabled: false },
    claudeSettingsFile: join(gitviewDir, "claude-settings.json"),
    repos,
    repoById: (id: string) => repos.find((r) => r.id === id),
    workspaceRoots: rl.map((r) => r.path),
    workspacesEnabled: true,
    rootsList: () => rl,
    rootById: (id: string) => rl.find((r) => r.id === id),
  };
}

function claudeSettingsStore(cfg: Config): ClaudeSettingsStore {
  return new ClaudeSettingsStore(cfg.claudeSettingsFile, cfg.claude.model || "claude-opus-4-8");
}

async function harness(): Promise<{ app: FastifyInstance; token: string; rootId: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "gv-open-root-"));
  const gitviewDir = await mkdtemp(join(tmpdir(), "gv-open-gv-"));
  created.push(root, gitviewDir);
  const cfg = makeConfig(root, gitviewDir);

  const audit = new AuditLog(cfg.auditFile);
  const auth = new AuthManager(cfg.tokensFile);
  const token = await auth.pair(auth.currentPairingCode);
  const files = new FileService(cfg.writeSizeCapBytes, audit);
  const gitWrite = new GitWrite(audit);
  const claudeSettings = claudeSettingsStore(cfg);
  const sessions = new SessionManager(cfg.claude, files, gitWrite, claudeSettings);
  const workspaces = new WorkspaceStore(cfg.workspacesFile);
  await workspaces.load();
  const served = await servedWorkspaceIds(cfg, workspaces);
  const registry = new RepoRegistry(cfg, workspaces, served);
  const live = new LiveChannel(auth, sessions, registry);
  const watcher = new RepoWatcher([], (r, p) => live.broadcastRepoChanged(r, p));
  const app = await buildServer({ cfg, auth, audit, files, gitWrite, sessions, claudeSettings, workspaces, registry, watcher, live });

  teardown.push(() => watcher.close());
  teardown.push(() => app.close());
  return { app, token, rootId: cfg.rootById(cfg.rootsList()[0]!.id)!.id, root };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test("a bare (non-git) folder returns needsInit and does NOT register", async () => {
  const { app, token, rootId, root } = await harness();
  await mkdir(join(root, "bare"), { recursive: true });

  const res = await app.inject({
    method: "POST", url: "/v1/workspaces/open", headers: auth(token),
    payload: { root: rootId, path: "bare" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { needsInit: true, path: "bare" });

  const repos = await app.inject({ method: "GET", url: "/v1/repos", headers: auth(token) });
  assert.equal((repos.json() as { repos: unknown[] }).repos.length, 0, "nothing registered yet");
});

test("initGit inits the folder, registers it, and it appears in the registry", async () => {
  const { app, token, rootId, root } = await harness();
  await mkdir(join(root, "fresh"), { recursive: true });

  const res = await app.inject({
    method: "POST", url: "/v1/workspaces/open", headers: auth(token),
    payload: { root: rootId, path: "fresh", initGit: true },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { repo?: { id: string } };
  assert.ok(body.repo, "returns a repo summary");
  assert.equal((await stat(join(root, "fresh", ".git"))).isDirectory(), true, ".git was created");

  const repos = (await app.inject({ method: "GET", url: "/v1/repos", headers: auth(token) }).then((r) => r.json())) as {
    repos: Array<{ id: string }>;
  };
  assert.ok(repos.repos.some((r) => r.id === body.repo!.id), "opened workspace appears in /v1/repos");

  // Regression guard: repo routes (and the live/chat channel, which shares this registry) must RESOLVE the
  // opened workspace by id — not just list it. Before the shared RepoRegistry, chat used cfg.repoById and
  // 404'd on opened workspaces even though files/git worked.
  const status = await app.inject({ method: "GET", url: `/v1/repos/${body.repo!.id}/status`, headers: auth(token) });
  assert.equal(status.statusCode, 200, "an opened workspace resolves through registry.byId (the chat path)");
});

test("opening an already-git folder registers it directly (no needsInit)", async () => {
  const { app, token, rootId, root } = await harness();
  const proj = join(root, "proj");
  await mkdir(proj, { recursive: true });
  await exec("git", ["-C", proj, "init", "-q"]);

  const res = await app.inject({
    method: "POST", url: "/v1/workspaces/open", headers: auth(token),
    payload: { root: rootId, path: "proj" },
  });
  assert.equal(res.statusCode, 200);
  assert.ok((res.json() as { repo?: unknown }).repo, "an existing repo registers without a prompt");
});

test("open is idempotent: re-opening the same folder does not duplicate it", async () => {
  const { app, token, rootId, root } = await harness();
  const proj = join(root, "dup");
  await mkdir(proj, { recursive: true });
  await exec("git", ["-C", proj, "init", "-q"]);

  const first = (await app.inject({
    method: "POST", url: "/v1/workspaces/open", headers: auth(token), payload: { root: rootId, path: "dup" },
  }).then((r) => r.json())) as { repo: { id: string } };
  const second = (await app.inject({
    method: "POST", url: "/v1/workspaces/open", headers: auth(token), payload: { root: rootId, path: "dup" },
  }).then((r) => r.json())) as { repo: { id: string } };

  assert.equal(first.repo.id, second.repo.id, "same id on re-open");
  const repos = (await app.inject({ method: "GET", url: "/v1/repos", headers: auth(token) }).then((r) => r.json())) as {
    repos: unknown[];
  };
  assert.equal(repos.repos.length, 1, "only one registration");
});

test("feature-off: with no roots, /v1/fs/* and /v1/workspaces/open are 404 and health reports it", async () => {
  const gitviewDir = await mkdtemp(join(tmpdir(), "gv-off-"));
  created.push(gitviewDir);
  const cfg = makeConfig(gitviewDir, gitviewDir);
  // Force the feature off.
  const off: Config = { ...cfg, workspaceRoots: [], workspacesEnabled: false, rootsList: () => [], rootById: () => undefined };

  const audit = new AuditLog(off.auditFile);
  const authMgr = new AuthManager(off.tokensFile);
  const token = await authMgr.pair(authMgr.currentPairingCode);
  const files = new FileService(off.writeSizeCapBytes, audit);
  const gitWrite = new GitWrite(audit);
  const claudeSettings = claudeSettingsStore(off);
  const sessions = new SessionManager(off.claude, files, gitWrite, claudeSettings);
  const workspaces = new WorkspaceStore(off.workspacesFile);
  const served = await servedWorkspaceIds(off, workspaces);
  const registry = new RepoRegistry(off, workspaces, served);
  const live = new LiveChannel(authMgr, sessions, registry);
  const watcher = new RepoWatcher([], (r, p) => live.broadcastRepoChanged(r, p));
  const app = await buildServer({ cfg: off, auth: authMgr, audit, files, gitWrite, sessions, claudeSettings, workspaces, registry, watcher, live });
  teardown.push(() => watcher.close());
  teardown.push(() => app.close());

  const h = (await app.inject({ method: "GET", url: "/v1/health" }).then((r) => r.json())) as {
    features?: { workspaces?: boolean };
  };
  assert.equal(h.features?.workspaces, false);

  for (const url of ["/v1/fs/roots", "/v1/fs/list?root=x"]) {
    const r = await app.inject({ method: "GET", url, headers: auth(token) });
    assert.equal(r.statusCode, 404, `${url} is 404 when the feature is off`);
  }
  const open = await app.inject({
    method: "POST", url: "/v1/workspaces/open", headers: auth(token), payload: { root: "x", path: "" },
  });
  assert.equal(open.statusCode, 404, "open is 404 when the feature is off");
});

test("remove: DELETE an opened workspace un-registers it but leaves the folder on disk", async () => {
  const { app, token, rootId, root } = await harness();
  const proj = join(root, "gone");
  await mkdir(proj, { recursive: true });
  await exec("git", ["-C", proj, "init", "-q"]);

  const opened = (await app.inject({
    method: "POST", url: "/v1/workspaces/open", headers: auth(token), payload: { root: rootId, path: "gone" },
  }).then((r) => r.json())) as { repo: { id: string; removable: boolean } };
  const id = opened.repo.id;
  assert.equal(opened.repo.removable, true, "an opened workspace is removable");

  const del = await app.inject({ method: "DELETE", url: `/v1/workspaces/${id}`, headers: auth(token) });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { ok: true });

  const repos = (await app.inject({ method: "GET", url: "/v1/repos", headers: auth(token) }).then((r) => r.json())) as {
    repos: Array<{ id: string }>;
  };
  assert.ok(!repos.repos.some((r) => r.id === id), "removed workspace is gone from /v1/repos");
  assert.equal((await stat(proj)).isDirectory(), true, "the folder on disk still exists after removal");
  assert.equal((await stat(join(proj, ".git"))).isDirectory(), true, "the .git dir on disk still exists too");

  // Its repo routes now 404 (surface withdrawn), and a second DELETE is a 404 (already gone).
  const status = await app.inject({ method: "GET", url: `/v1/repos/${id}/status`, headers: auth(token) });
  assert.equal(status.statusCode, 404, "removed workspace's routes 404");
  const again = await app.inject({ method: "DELETE", url: `/v1/workspaces/${id}`, headers: auth(token) });
  assert.equal(again.statusCode, 404, "removing an unknown id is 404");
});

test("remove: DELETE an unknown id is 404", async () => {
  const { app, token } = await harness();
  const res = await app.inject({ method: "DELETE", url: "/v1/workspaces/nope", headers: auth(token) });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { error: { code: string } }).error.code, "not_found");
});

test("remove: DELETE a config repo id is 403 and removable is false for it", async () => {
  const root = await mkdtemp(join(tmpdir(), "gv-cfgrepo-root-"));
  const gitviewDir = await mkdtemp(join(tmpdir(), "gv-cfgrepo-gv-"));
  created.push(root, gitviewDir);
  // A real git repo that will be a CONFIG repo (not a workspace).
  const cfgRepoPath = join(root, "cfgrepo");
  await mkdir(cfgRepoPath, { recursive: true });
  await exec("git", ["-C", cfgRepoPath, "init", "-q"]);

  const base = makeConfig(root, gitviewDir);
  const repos: Config["repos"] = [
    { id: "cfg-repo", name: "cfg-repo", path: cfgRepoPath, provider: "local-sdk", profile: "auto" },
  ];
  const cfg: Config = { ...base, repos, repoById: (id: string) => repos.find((r) => r.id === id) };

  const audit = new AuditLog(cfg.auditFile);
  const authMgr = new AuthManager(cfg.tokensFile);
  const token = await authMgr.pair(authMgr.currentPairingCode);
  const files = new FileService(cfg.writeSizeCapBytes, audit);
  const gitWrite = new GitWrite(audit);
  const claudeSettings = claudeSettingsStore(cfg);
  const sessions = new SessionManager(cfg.claude, files, gitWrite, claudeSettings);
  const workspaces = new WorkspaceStore(cfg.workspacesFile);
  await workspaces.load();
  const served = await servedWorkspaceIds(cfg, workspaces);
  const registry = new RepoRegistry(cfg, workspaces, served);
  const live = new LiveChannel(authMgr, sessions, registry);
  const watcher = new RepoWatcher([], (r, p) => live.broadcastRepoChanged(r, p));
  const app = await buildServer({ cfg, auth: authMgr, audit, files, gitWrite, sessions, claudeSettings, workspaces, registry, watcher, live });
  teardown.push(() => watcher.close());
  teardown.push(() => app.close());

  const repoList = (await app.inject({ method: "GET", url: "/v1/repos", headers: auth(token) }).then((r) => r.json())) as {
    repos: Array<{ id: string; removable: boolean }>;
  };
  const cfgRow = repoList.repos.find((r) => r.id === "cfg-repo");
  assert.equal(cfgRow?.removable, false, "a config repo is NOT removable");

  const del = await app.inject({ method: "DELETE", url: "/v1/workspaces/cfg-repo", headers: auth(token) });
  assert.equal(del.statusCode, 403, "refusing to remove a config repo");
  assert.equal((del.json() as { error: { code: string } }).error.code, "forbidden");
});

test("revocation: a persisted workspace outside the current roots is no longer served", async () => {
  const root = await mkdtemp(join(tmpdir(), "gv-rev-root-"));
  const gitviewDir = await mkdtemp(join(tmpdir(), "gv-rev-gv-"));
  const otherRoot = await mkdtemp(join(tmpdir(), "gv-rev-other-"));
  created.push(root, gitviewDir, otherRoot);

  const audit = new AuditLog(join(gitviewDir, "audit.log"));
  const files = new FileService(8 * 1024 * 1024, audit);
  const gitWrite = new GitWrite(audit);

  // --- server #1: `root` is browsable; open a git repo inside it (persists to workspaces.json) ---
  const cfg1 = makeConfig(root, gitviewDir);
  const auth1 = new AuthManager(cfg1.tokensFile);
  const token1 = await auth1.pair(auth1.currentPairingCode);
  const sessions1 = new SessionManager(cfg1.claude, files, gitWrite, claudeSettingsStore(cfg1));
  const ws1 = new WorkspaceStore(cfg1.workspacesFile);
  await ws1.load();
  const served1 = await servedWorkspaceIds(cfg1, ws1);
  const registry1 = new RepoRegistry(cfg1, ws1, served1);
  const live1 = new LiveChannel(auth1, sessions1, registry1);
  const watcher1 = new RepoWatcher([], (r, p) => live1.broadcastRepoChanged(r, p));
  const app1 = await buildServer({ cfg: cfg1, auth: auth1, audit, files, gitWrite, sessions: sessions1, claudeSettings: claudeSettingsStore(cfg1), workspaces: ws1, registry: registry1, watcher: watcher1, live: live1 });
  teardown.push(() => watcher1.close()); teardown.push(() => app1.close());

  await mkdir(join(root, "keep"), { recursive: true });
  await exec("git", ["-C", join(root, "keep"), "init", "-q"]);
  const opened = (await app1.inject({
    method: "POST", url: "/v1/workspaces/open", headers: auth(token1),
    payload: { root: cfg1.rootsList()[0]!.id, path: "keep" },
  }).then((r) => r.json())) as { repo: { id: string } };
  const id = opened.repo.id;

  // --- server #2: SAME workspaces.json, but roots narrowed to a different dir (`keep` now outside) ---
  const cfg2 = makeConfig(otherRoot, gitviewDir); // shares gitviewDir => same workspacesFile
  const auth2 = new AuthManager(cfg2.tokensFile);
  const token2 = await auth2.pair(auth2.currentPairingCode);
  const sessions2 = new SessionManager(cfg2.claude, files, gitWrite, claudeSettingsStore(cfg2));
  const ws2 = new WorkspaceStore(cfg2.workspacesFile);
  await ws2.load(); // re-reads the persisted "keep"
  const served2 = await servedWorkspaceIds(cfg2, ws2);
  const registry2 = new RepoRegistry(cfg2, ws2, served2);
  const live2 = new LiveChannel(auth2, sessions2, registry2);
  const watcher2 = new RepoWatcher([], (r, p) => live2.broadcastRepoChanged(r, p));
  const app2 = await buildServer({ cfg: cfg2, auth: auth2, audit, files, gitWrite, sessions: sessions2, claudeSettings: claudeSettingsStore(cfg2), workspaces: ws2, registry: registry2, watcher: watcher2, live: live2 });
  teardown.push(() => watcher2.close()); teardown.push(() => app2.close());

  assert.equal(ws2.byId(id)?.id, id, "the record is still persisted in workspaces.json");
  assert.equal(served2.has(id), false, "but it is NOT served once it falls outside every current root");
  const repos2 = (await app2.inject({ method: "GET", url: "/v1/repos", headers: auth(token2) }).then((r) => r.json())) as {
    repos: Array<{ id: string }>;
  };
  assert.ok(!repos2.repos.some((r) => r.id === id), "revoked workspace is absent from /v1/repos");
  const refs = await app2.inject({ method: "GET", url: `/v1/repos/${id}/refs`, headers: auth(token2) });
  assert.equal(refs.statusCode, 404, "revoked workspace's repo routes 404 (read/write surface withdrawn)");
});
