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
  await sleep(400); // let chokidar establish the watch (ignoreInitial)
  await writeFile(join(dir, "a.txt"), "changed\n");
  await writeFile(join(dir, "b.txt"), "new\n");
  await sleep(700); // > awaitWriteFinish (150) + debounce (80)
  const all = events.flat();
  assert.ok(all.includes("a.txt"), `reports a.txt change (got ${JSON.stringify(all)})`);
  assert.ok(all.includes("b.txt"), "reports new b.txt");
  assert.ok(events.length <= 2, `two near-simultaneous writes coalesce (${events.length} emissions)`);
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
