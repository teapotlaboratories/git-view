import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { WorkspaceStore, servedWorkspaceIds, type WorkspaceRecord } from "../src/workspaces/store.js";
import { slugifyId, type Config, type WorkspaceRoot } from "../src/config.js";

/** A minimal Config exposing only the root helpers servedWorkspaceIds touches. */
function cfgWithRoots(...paths: string[]): Config {
  const rl: WorkspaceRoot[] = paths.map((p) => ({ id: slugifyId(basename(p)), path: p, label: basename(p) }));
  return {
    workspaceRoots: paths,
    workspacesEnabled: paths.length > 0,
    rootsList: () => rl,
    rootById: (id: string) => rl.find((r) => r.id === id),
  } as unknown as Config;
}

const created: string[] = [];
async function storeFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gv-ws-"));
  created.push(dir);
  return join(dir, "workspaces.json");
}
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {}))));

const rec = (id: string, path: string): WorkspaceRecord => ({
  id, path, provider: "local-sdk", profile: "auto", openedAt: new Date().toISOString(),
});

test("add persists and reloads round-trip in a new instance", async () => {
  const file = await storeFile();
  const s1 = new WorkspaceStore(file);
  await s1.add(rec("proj", "/home/u/proj"));
  await s1.add(rec("other", "/home/u/other"));

  const s2 = new WorkspaceStore(file);
  await s2.load();
  assert.equal(s2.list().length, 2);
  assert.equal(s2.byId("proj")?.path, "/home/u/proj");
  assert.equal(s2.byPath("/home/u/other")?.id, "other");
});

test("a repeated id de-dupes (last write wins, not appended)", async () => {
  const file = await storeFile();
  const s = new WorkspaceStore(file);
  await s.add(rec("proj", "/home/u/a"));
  await s.add(rec("proj", "/home/u/b"));
  assert.equal(s.list().length, 1);
  assert.equal(s.byId("proj")?.path, "/home/u/b");
});

test("the store file is written owner-only (0600)", async () => {
  const file = await storeFile();
  const s = new WorkspaceStore(file);
  await s.add(rec("proj", "/home/u/proj"));
  const st = await stat(file);
  assert.equal(st.mode & 0o777, 0o600, "workspaces.json must be owner-only");
});

test("load on a missing file is a no-op (first run)", async () => {
  const s = new WorkspaceStore(await storeFile());
  await s.load();
  assert.deepEqual(s.list(), []);
});

test("servedWorkspaceIds keeps only workspaces still inside a current root", async () => {
  const root = await mkdtemp(join(tmpdir(), "gv-root-"));
  created.push(root);
  const s = new WorkspaceStore(await storeFile());
  await s.add(rec("inside", join(root, "proj"))); // lexically inside the root
  await s.add(rec("outside", join(tmpdir(), "gv-elsewhere-not-a-root")));

  const served = await servedWorkspaceIds(cfgWithRoots(root), s);
  assert.deepEqual([...served], ["inside"], "the out-of-root record is dropped from the served set");
});

test("servedWorkspaceIds is empty when the feature is disabled (no roots)", async () => {
  const s = new WorkspaceStore(await storeFile());
  await s.add(rec("proj", "/anywhere/proj"));
  const served = await servedWorkspaceIds(cfgWithRoots(), s); // no roots => feature off
  assert.equal(served.size, 0);
});
