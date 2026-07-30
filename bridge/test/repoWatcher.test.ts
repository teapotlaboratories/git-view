import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoWatcher } from "../src/git/repoWatcher.js";
import type { RepoConfig } from "../src/config.js";

const created: string[] = [];
const watchers: RepoWatcher[] = [];
after(async () => {
  await Promise.all(watchers.map((w) => w.close().catch(() => {})));
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tmpRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gv-watch-"));
  created.push(dir);
  await writeFile(join(dir, "a.txt"), "hello\n");
  await mkdir(join(dir, ".git", "refs", "heads"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  await mkdir(join(dir, ".gitview"), { recursive: true });
  return dir;
}

function start(dir: string, sink: string[][]): RepoWatcher {
  const repo = { id: "r", name: "r", path: dir } as RepoConfig;
  const w = new RepoWatcher([repo], (_id, paths) => sink.push(paths), 80);
  watchers.push(w);
  w.start();
  return w;
}

test("reports and coalesces working-tree changes", async () => {
  const dir = await tmpRepo();
  const events: string[][] = [];
  start(dir, events);
  await sleep(400); // let the native watcher finish its initial walk before we touch files
  await writeFile(join(dir, "a.txt"), "changed\n");
  await writeFile(join(dir, "b.txt"), "new\n");
  await sleep(700); // > awaitWriteFinish (150) + debounce (80)
  const all = events.flat();
  assert.ok(all.includes("a.txt"), `reports a.txt change (got ${JSON.stringify(all)})`);
  assert.ok(all.includes("b.txt"), "reports new b.txt");
  assert.ok(events.length <= 2, `two near-simultaneous writes coalesce (${events.length} emissions)`);
});

test("gitignored churn (build/, *.log) does not fire repo.changed; tracked paths still do", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "gv-watch-ign-"));
  created.push(dir);
  await exec("git", ["-C", dir, "init", "-q"]); // a REAL repo so check-ignore works
  await writeFile(join(dir, ".gitignore"), "build/\n*.log\n");
  await mkdir(join(dir, "build"), { recursive: true });
  const events: string[][] = [];
  start(dir, events);
  await sleep(400);
  await writeFile(join(dir, "build", "out.o"), "1"); // gitignored — must be silent
  await writeFile(join(dir, "app.log"), "line");     // gitignored — must be silent
  await sleep(700);
  assert.equal(
    events.flat().filter((p) => p === "build/out.o" || p === "app.log").length,
    0,
    `gitignored churn must not fire repo.changed (got ${JSON.stringify(events)})`,
  );
  await writeFile(join(dir, "src.txt"), "code"); // NOT ignored — must fire
  await sleep(700);
  assert.ok(events.flat().includes("src.txt"), "a non-ignored change is still reported");
});

test("ignores .gitview and .git noise, surfaces .git/HEAD and refs", async () => {
  const dir = await tmpRepo();
  const events: string[][] = [];
  start(dir, events);
  await sleep(400);
  await writeFile(join(dir, ".gitview", "tokens.json"), "SECRET\n");
  await writeFile(join(dir, ".git", "COMMIT_EDITMSG"), "noise\n"); // .git noise (not HEAD/index/refs)
  await sleep(500);
  assert.equal(events.flat().length, 0, `no events for .gitview / .git noise (got ${JSON.stringify(events.flat())})`);

  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/dev\n");
  await writeFile(join(dir, ".git", "refs", "heads", "main"), "abc123\n");
  await sleep(500);
  const all = events.flat();
  assert.ok(all.some((p) => p === join(".git", "HEAD")), `surfaces .git/HEAD (got ${JSON.stringify(all)})`);
  assert.ok(all.some((p) => p.startsWith(join(".git", "refs"))), "surfaces .git/refs change");
});

test("unwatch(id) closes and removes a runtime watcher", async () => {
  const dir = await tmpRepo();
  const events: string[][] = [];
  const w = new RepoWatcher([], (_id, paths) => events.push(paths), 80);
  watchers.push(w);
  const repo = { id: "u", name: "u", path: dir } as RepoConfig;
  w.watch(repo);
  await sleep(400);
  await w.unwatch("u");
  await writeFile(join(dir, "a.txt"), "after unwatch\n");
  await sleep(400);
  assert.equal(events.flat().length, 0, "no events after unwatch()");

  // unwatch of an unknown / already-removed id is a harmless no-op
  await w.unwatch("u");
  await w.unwatch("never-watched");
});

test("a double watch(same id) is a no-op (one unwatch removes it entirely)", async () => {
  const dir = await tmpRepo();
  const events: string[][] = [];
  const w = new RepoWatcher([], (_id, paths) => events.push(paths), 80);
  watchers.push(w);
  const repo = { id: "d", name: "d", path: dir } as RepoConfig;
  w.watch(repo);
  w.watch(repo); // second call must be ignored — no duplicate watcher
  await sleep(400);
  await w.unwatch("d"); // if the double watch created two watchers, one would survive this
  await writeFile(join(dir, "a.txt"), "after single unwatch\n");
  await sleep(400);
  assert.equal(events.flat().length, 0, "double watch created only one watcher; unwatch fully detaches it");
});

test("close() stops further events", async () => {
  const dir = await tmpRepo();
  const events: string[][] = [];
  const w = start(dir, events);
  await sleep(400);
  await w.close();
  await writeFile(join(dir, "a.txt"), "after close\n");
  await sleep(400);
  assert.equal(events.flat().length, 0, "no events after close()");
});

// ---- submodules (owner-reported: rimba's diff refreshed every second on quartz) ---------------

/** A superproject with one real submodule, each with its own .gitignore. */
async function repoWithSubmodule(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "gv-watch-sub-"));
  created.push(root);

  const sub = join(root, "_sub_src");
  await mkdir(sub, { recursive: true });
  await exec("git", ["-C", sub, "init", "-q"]);
  await writeFile(join(sub, "keep.txt"), "x\n");
  await writeFile(join(sub, ".gitignore"), "subignored/\n");
  await exec("git", ["-C", sub, "add", "-A"]);
  await exec("git", ["-C", sub, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

  await exec("git", ["-C", root, "init", "-q"]);
  await writeFile(join(root, ".gitignore"), "build/\n");
  await exec("git", ["-C", root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/sub"]);
  await exec("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add sub"]);
  return root;
}

test("a transient .git lock inside a submodule does NOT fire (it caused a 1s refresh loop)", async () => {
  const root = await repoWithSubmodule();
  // Created BEFORE watching: in a real repo the .git dir already exists, and we are testing the lock
  // churn, not directory creation.
  await mkdir(join(root, "vendor", "other", ".git"), { recursive: true });
  const events: string[][] = [];
  start(root, events);
  await sleep(400);
  // Exactly what serving a worktree diff does on a repo with submodules: git takes the submodule's
  // index lock and drops it again. Reporting that made the app re-fetch the diff, which took it again.
  // BOTH real-world layouts: `git submodule add` leaves a .git GITFILE so the lock lands under
  // .git/modules/<name>/, while an older/direct clone (rimba vendor/esp-idf) has a real .git DIRECTORY.
  for (const lock of [join(root, ".git", "modules", "vendor", "sub", "index.lock"),
                      join(root, "vendor", "other", ".git", "index.lock")]) {
    await writeFile(lock, "");
    await sleep(300); // outlive awaitWriteFinish (150ms) — a lock deleted instantly is never emitted,
    await rm(lock, { force: true }); // so a "pass" without this would prove nothing
  }
  await sleep(700);
  assert.deepEqual(events.flat(), [], `submodule lock churn must stay silent (got ${JSON.stringify(events.flat())})`);
});

test("a REAL file change inside a submodule still fires", async () => {
  const root = await repoWithSubmodule();
  const events: string[][] = [];
  start(root, events);
  await sleep(400);
  await writeFile(join(root, "vendor", "sub", "keep.txt"), "edited\n");
  await sleep(700);
  assert.ok(
    events.flat().some((p) => p === "vendor/sub/keep.txt"),
    `submodule edits must still be reported (got ${JSON.stringify(events.flat())})`,
  );
});

test("a submodule's OWN .gitignore is applied (check-ignore runs inside it)", async () => {
  const root = await repoWithSubmodule();
  const events: string[][] = [];
  start(root, events);
  await sleep(400);
  await mkdir(join(root, "vendor", "sub", "subignored"), { recursive: true });
  await writeFile(join(root, "vendor", "sub", "subignored", "out.o"), "x\n");
  await sleep(700);
  assert.deepEqual(
    events.flat().filter((p) => p.includes("subignored")), [],
    "paths ignored by the submodule's own .gitignore must be dropped",
  );
});

test("one submodule path does not disable filtering for the whole batch", async () => {
  // check-ignore refuses a path inside a submodule (exit 128). dropIgnored fails open, so before
  // partitioning by owning repo, a single submodule path let ALL gitignored churn through with it.
  const root = await repoWithSubmodule();
  const events: string[][] = [];
  start(root, events);
  await sleep(400);
  await mkdir(join(root, "build"), { recursive: true });
  await writeFile(join(root, "build", "ignored.o"), "x\n");           // ignored by the superproject
  await writeFile(join(root, "vendor", "sub", "keep.txt"), "again\n"); // real submodule edit, same batch
  await sleep(700);
  const all = events.flat();
  assert.ok(all.includes("vendor/sub/keep.txt"), `the real edit is reported (got ${JSON.stringify(all)})`);
  assert.deepEqual(all.filter((p) => p.startsWith("build/")), [], "ignored churn must NOT ride along with it");
});

test("a NESTED submodule's .gitignore wins over its parent's (prefix ordering)", async () => {
  // Ownership takes the first matching prefix, so prefixes must be sorted longest-first — otherwise
  // "vendor/sub" would claim "vendor/sub/inner/…" and check-ignore would run in the wrong repo.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const root = await repoWithSubmodule();

  const inner = join(root, "_inner_src");
  await mkdir(inner, { recursive: true });
  await exec("git", ["-C", inner, "init", "-q"]);
  await writeFile(join(inner, "f.txt"), "x\n");
  await writeFile(join(inner, ".gitignore"), "innerignored/\n"); // ONLY the inner repo ignores this
  await exec("git", ["-C", inner, "add", "-A"]);
  await exec("git", ["-C", inner, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

  const sub = join(root, "vendor", "sub");
  await exec("git", ["-C", sub, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "inner"]);
  await exec("git", ["-C", sub, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "nest"]);

  const events: string[][] = [];
  start(root, events);
  await sleep(400);
  await mkdir(join(sub, "inner", "innerignored"), { recursive: true });
  await writeFile(join(sub, "inner", "innerignored", "o.tmp"), "x\n");
  await writeFile(join(sub, "inner", "f.txt"), "edited\n");
  await sleep(900);
  const all = events.flat();
  assert.ok(all.some((p) => p.endsWith("inner/f.txt")), `the real nested edit fires (got ${JSON.stringify(all)})`);
  assert.deepEqual(all.filter((p) => p.includes("innerignored")), [],
    "the NESTED submodule's own .gitignore must apply, not just its parent's");
});

test("unwatch drops the cached submodule list (a repo re-opened at the same path re-reads it)", async () => {
  const root = await repoWithSubmodule();
  // ONE watcher instance throughout: the cache is per-instance, so constructing a second watcher
  // would start empty and prove nothing about eviction.
  const events: string[][] = [];
  const repo = { id: "r", name: "r", path: root } as RepoConfig;
  const w = new RepoWatcher([repo], (_id, paths) => events.push(paths), 80);
  watchers.push(w);
  w.start();
  await sleep(400);
  await writeFile(join(root, "vendor", "sub", "keep.txt"), "one\n"); // warms the prefix cache
  await sleep(700);
  await w.unwatch("r");

  // Add a SECOND submodule while detached. Only an evicted cache re-reads the prefix list and learns
  // about it; a retained one would miss it, fail check-ignore open for that batch, and leak the churn.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const late = join(root, "_late_src");
  await mkdir(late, { recursive: true });
  await exec("git", ["-C", late, "init", "-q"]);
  await writeFile(join(late, "f.txt"), "x\n");
  await writeFile(join(late, ".gitignore"), "lateignored/\n");
  await exec("git", ["-C", late, "add", "-A"]);
  await exec("git", ["-C", late, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  await exec("git", ["-C", root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", late, "vendor/late"]);

  const mark = events.length;
  w.watch(repo); // same instance — a retained cache would still be in play here
  await sleep(400);
  await mkdir(join(root, "vendor", "late", "lateignored"), { recursive: true });
  await writeFile(join(root, "vendor", "late", "lateignored", "x.o"), "x\n"); // ignored by the NEW submodule
  await writeFile(join(root, "vendor", "sub", "keep.txt"), "two\n");           // real edit
  await sleep(900);
  const all = events.slice(mark).flat();
  assert.ok(all.includes("vendor/sub/keep.txt"), `still reports real edits after re-watch (got ${JSON.stringify(all)})`);
  assert.deepEqual(all.filter((p) => p.includes("lateignored")), [],
    "a submodule added while detached must be picked up on re-watch — proving the cache was evicted");
});
