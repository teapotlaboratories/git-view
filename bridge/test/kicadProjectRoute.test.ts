import { test, after } from "node:test";
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

/**
 * The project endpoint, exercised through the real route (ADR-040).
 *
 * These exist because the pure tests in `kicadProject.test.ts` **cannot** catch the bug that shipped
 * here. `describeProject` was correct; the route handed it the wrong stem. Opening a sub-sheet reported
 * that the project had no board — while the board named by that very project sat beside it — and the
 * pure test passed the whole time, because it asserted the fields the route happened to get right.
 *
 * So the rule is the wiring, and the wiring needs a test that goes through HTTP.
 */

const exec = promisify(execFile);
const created: string[] = [];
const teardown: Array<() => Promise<void> | void> = [];
after(async () => {
  await Promise.all(teardown.map((f) => Promise.resolve(f()).catch(() => {})));
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** A repo laid out like the `video` demo: a project, its root sheet, its board, and a sub-sheet. */
async function harness(): Promise<{ app: FastifyInstance; token: string; repoId: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "gv-kproj-"));
  const gv = await mkdtemp(join(tmpdir(), "gv-kproj-gv-"));
  created.push(repoPath, gv);

  await mkdir(join(repoPath, "video", "libs"), { recursive: true });
  const put = (p: string, body = "(kicad_pcb (version 20241229))\n") => writeFile(join(repoPath, p), body);
  await put("video/video.kicad_pro", "{}\n");
  await put("video/video.kicad_sch", "(kicad_sch (version 20241229))\n");
  await put("video/video.kicad_pcb");
  await put("video/muxdata.kicad_sch", "(kicad_sch (version 20241229))\n");
  // Two projects in one directory, so the refusal path has something real to refuse.
  await mkdir(join(repoPath, "ecc83"), { recursive: true });
  await put("ecc83/a.kicad_pro", "{}\n");
  await put("ecc83/b.kicad_pro", "{}\n");
  await put("ecc83/loose.kicad_sch", "(kicad_sch (version 20241229))\n");
  // An extension that is not lowercase. Git paths are case-sensitive, so a hard-coded lowercase
  // candidate misses the real file and the endpoint 404s on something that is right there.
  await mkdir(join(repoPath, "shouty"), { recursive: true });
  await put("shouty/Board.KICAD_PCB");
  await put("shouty/Proj.KICAD_PRO", "{}\n");
  // A SECOND board in the video project's directory, pairing with no .kicad_pro of its own.
  await put("video/other.kicad_pcb");

  await exec("git", ["init", "-q"], { cwd: repoPath });
  await exec("git", ["add", "-A"], { cwd: repoPath });
  await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"], { cwd: repoPath });

  const repos: Config["repos"] = [
    { id: "fx", name: "fx", path: repoPath, provider: "local-sdk", profile: "auto" } as Config["repos"][number],
  ];
  const cfg = {
    bind: "127.0.0.1", port: 0,
    tokensFile: join(gv, "tokens.json"),
    pairingCodeTtlMs: 600_000,
    workspacesFile: join(gv, "workspaces.json"),
    bodyLimitBytes: 8 * 1024 * 1024, writeSizeCapBytes: 4 * 1024 * 1024,
    auditFile: join(gv, "audit.log"),
    claude: { defaultProvider: "local-sdk", defaultProfile: "auto", sandbox: { enabled: false } },
    terminal: { enabled: false },
    claudeSettingsFile: join(gv, "claude-settings.json"),
    repos,
    repoById: (id: string) => repos.find((r) => r.id === id),
    workspaceRoots: [], workspacesEnabled: false,
    rootsList: () => [], rootById: () => undefined,
    kicadModelPaths: {}, kicadModelVars: new Set<string>(),
  } as unknown as Config;

  const audit = new AuditLog(cfg.auditFile);
  const auth = new AuthManager(cfg.tokensFile);
  const token = await auth.pair(auth.currentPairingCode);
  const files = new FileService(cfg.writeSizeCapBytes, audit);
  const gitWrite = new GitWrite(audit);
  const workspaces = new WorkspaceStore(cfg.workspacesFile);
  await workspaces.load();
  const registry = new RepoRegistry(cfg, workspaces, new Set());
  const app = await buildServer({
    cfg, auth, audit, files, gitWrite, workspaces, registry,
    claudeSettings: new ClaudeSettingsStore(cfg.claudeSettingsFile, "claude-opus-4-8"),
    watcher: { close: () => {} }, live: { connectedDeviceIds: () => new Set() },
  } as never);
  teardown.push(() => app.close());
  return { app, token, repoId: "fx" };
}

const get = async (app: FastifyInstance, token: string, path: string, ref?: string) =>
  app.inject({
    method: "GET",
    url: `/v1/repos/fx/kicad/project?path=${encodeURIComponent(path)}${ref ? `&ref=${ref}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });

test("a sub-sheet's answer carries the PROJECT's board, not its own stem's", async () => {
  // The bug this file exists for. `video/muxdata.kicad_sch` pairs with nothing by name, so the route
  // resolved the project through the `.kicad_pro` beside it — and then went on describing the *sheet's*
  // stem, looking for `video/muxdata.kicad_pcb`. Result: no board, on a project that plainly has one.
  // Every sub-sheet lost its PCB tab; `vme-wren` has 36 of them.
  const { app, token } = await harness();
  const res = await get(app, token, "video/muxdata.kicad_sch");
  assert.equal(res.statusCode, 200);
  const b = res.json() as Record<string, string>;
  assert.equal(b["board"], "video/video.kicad_pcb", "the project's board");
  assert.equal(b["schematic"], "video/video.kicad_sch", "the project's ROOT sheet");
  assert.equal(b["sheet"], "video/muxdata.kicad_sch", "and the sheet actually asked about, kept separate");
  assert.equal(b["name"], "video", "named for the project, not the sheet");
});

test("the root sheet and the board describe the same project", async () => {
  const { app, token } = await harness();
  for (const p of ["video/video.kicad_sch", "video/video.kicad_pcb", "video/video.kicad_pro"]) {
    const b = (await get(app, token, p)).json() as Record<string, string>;
    assert.equal(b["project"], "video/video.kicad_pro", p);
    assert.equal(b["schematic"], "video/video.kicad_sch", p);
    assert.equal(b["board"], "video/video.kicad_pcb", p);
    assert.ok(!("sheet" in b), `${p}: the requested file IS a half, so no separate sheet is named`);
  }
});

test("a `..` segment is normalised, and answers the same at a ref as in the worktree", async () => {
  // Un-normalised input echoed `video/libs/../video.kicad_pcb` back as a resolved path the app would
  // re-request, and — the part that makes it a defect — answered 200 in the working tree but 404 at a
  // commit, because `git rev-parse ref:a/../b` does not collapse the way a filesystem does.
  const { app, token } = await harness();
  const worktree = await get(app, token, "video/libs/../video.kicad_sch");
  assert.equal(worktree.statusCode, 200);
  assert.equal((worktree.json() as Record<string, string>)["board"], "video/video.kicad_pcb",
    "no `..` survives into a path the client will send back");
  const atRef = await get(app, token, "video/libs/../video.kicad_sch", "HEAD");
  assert.equal(atRef.statusCode, 200, "and a commit answers the same way the worktree does");
});

test("two projects beside a loose sheet is a refusal, over HTTP", async () => {
  const { app, token } = await harness();
  const b = (await get(app, token, "ecc83/loose.kicad_sch")).json() as Record<string, string>;
  assert.equal(b["unresolved"], "ambiguous");
  assert.ok(!("project" in b), "and no project is guessed at");
});

test("a file that is not there is 404, not an answer about its neighbours", async () => {
  const { app, token } = await harness();
  assert.equal((await get(app, token, "ecc83/invented.kicad_sch")).statusCode, 404);
  assert.equal((await get(app, token, "video/video.kicad_sym")).statusCode, 400, "and a non-project file is 400");
});

test("a non-lowercase extension is not a 404 on a file that is right there", () => {
  // `projectBasename` accepts case-insensitively while `projectPaths` only ever emits the canonical
  // spelling, so the existence probe looked for `shouty/Board.kicad_pcb` — a different file on any
  // case-sensitive filesystem — and reported the board absent, then 404'd the whole request.
  return harness().then(async ({ app, token }) => {
    const res = await get(app, token, "shouty/Board.KICAD_PCB");
    assert.equal(res.statusCode, 200, "the file exists, so it must be described");
    assert.equal((res.json() as Record<string, string>)["board"], "shouty/Board.KICAD_PCB",
      "and reported under the name it actually has");
  });
});

test("a second board in a project's directory is not swapped for the project's board", () => {
  // Only a *schematic* can be a sub-sheet: a KiCad project has one board, named for the project. Running
  // the sibling-project fallback for a `.kicad_pcb` re-derived everything from the project's stem and
  // discarded the board that was actually asked for — `video/other.kicad_pcb` answered
  // `board: video/video.kicad_pcb`, so the app would have opened a different board than the user tapped.
  return harness().then(async ({ app, token }) => {
    const b = (await get(app, token, "video/other.kicad_pcb")).json() as Record<string, string>;
    assert.equal(b["board"], "video/other.kicad_pcb", "the board the client named");
    assert.ok(!("schematic" in b), "and no schematic borrowed from a project it does not belong to");
  });
});

test("an uppercase .kicad_pro is reported as the project", () => {
  // The case-preserving patch covered .kicad_sch and .kicad_pcb but not .kicad_pro, so a Foo.KICAD_PRO
  // that exists came back with no `project` at all — having paid for a directory listing on the way.
  return harness().then(async ({ app, token }) => {
    const b = (await get(app, token, "shouty/Proj.KICAD_PRO")).json() as Record<string, string>;
    assert.equal(b["project"], "shouty/Proj.KICAD_PRO");
    assert.ok(!("unresolved" in b), "it named the project itself — nothing is ambiguous");
  });
});
