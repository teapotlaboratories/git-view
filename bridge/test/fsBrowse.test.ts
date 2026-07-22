import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { list, mkdir as fsMkdir, roots } from "../src/fs/fsBrowse.js";
import { slugifyId, type Config, type WorkspaceRoot } from "../src/config.js";

const created: string[] = [];
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {}))));

async function tmp(prefix = "gv-fs-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

/** A minimal Config exposing only the root helpers fsBrowse touches. */
function cfgFor(...paths: string[]): Config {
  const rootsList: WorkspaceRoot[] = paths.map((p) => ({ id: slugifyId(basename(p)), path: p, label: basename(p) }));
  return {
    workspaceRoots: rootsList.map((r) => r.path),
    workspacesEnabled: rootsList.length > 0,
    rootsList: () => rootsList,
    rootById: (id: string) => rootsList.find((r) => r.id === id),
  } as unknown as Config;
}

/** A root with dirs (one a git repo), files, and dotfiles for ordering/visibility checks. */
async function populatedRoot(): Promise<{ root: string; id: string }> {
  const root = await tmp();
  await mkdir(join(root, "zeta"), { recursive: true });
  await mkdir(join(root, "alpha", ".git"), { recursive: true }); // alpha is a git repo
  await mkdir(join(root, ".hidden"), { recursive: true });
  await writeFile(join(root, "m.txt"), "x");
  await writeFile(join(root, ".dotfile"), "x");
  return { root, id: slugifyId(basename(root)) };
}

test("roots() returns the configured roots", async () => {
  const root = await tmp();
  const cfg = cfgFor(root);
  const rs = roots(cfg);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.path, root);
  assert.equal(rs[0]!.label, basename(root));
});

test("unknown root id is rejected", async () => {
  const cfg = cfgFor(await tmp());
  await assert.rejects(() => list(cfg, "no-such-root", ""), /not found/i);
});

test("absolute path is rejected", async () => {
  const { root, id } = await populatedRoot();
  const cfg = cfgFor(root);
  await assert.rejects(() => list(cfg, id, "/etc/passwd"), /absolute/i);
});

test("`..` traversal is rejected", async () => {
  const { root, id } = await populatedRoot();
  const cfg = cfgFor(root);
  await assert.rejects(() => list(cfg, id, "../.."), /path_escape|escaped/i);
});

test("a symlink escaping the root is rejected", async () => {
  const { root, id } = await populatedRoot();
  const outside = await tmp("gv-outside-");
  await writeFile(join(outside, "secret"), "s");
  await symlink(outside, join(root, "link")); // root/link -> outside
  const cfg = cfgFor(root);
  await assert.rejects(() => list(cfg, id, "link"), /symlink|escaped|path_escape/i);
});

test("list: dirs first, then files, name-sorted, with dotfiles shown and isRepo marked", async () => {
  const { root, id } = await populatedRoot();
  const cfg = cfgFor(root);
  const res = await list(cfg, id, "");
  assert.equal(res.root, id);
  assert.equal(res.path, "");
  assert.equal(res.parent, null); // null at the root

  const names = res.entries.map((e) => e.name);
  // dirs (name-sorted) then files (name-sorted); dotfiles included
  assert.deepEqual(names, [".hidden", "alpha", "zeta", ".dotfile", "m.txt"]);
  assert.deepEqual(res.entries.map((e) => e.kind), ["dir", "dir", "dir", "file", "file"]);

  const alpha = res.entries.find((e) => e.name === "alpha")!;
  assert.equal(alpha.isRepo, true, "alpha (has .git) is flagged isRepo");
  const zeta = res.entries.find((e) => e.name === "zeta")!;
  assert.equal(zeta.isRepo, undefined, "a plain dir is not flagged");
});

test("list: parent is the empty string one level down", async () => {
  const { root, id } = await populatedRoot();
  const cfg = cfgFor(root);
  const res = await list(cfg, id, "alpha");
  assert.equal(res.parent, "", "a first-level dir's parent is the root itself");
});

test("mkdir creates a child dir and refuses to clobber", async () => {
  const root = await tmp();
  const id = slugifyId(basename(root));
  const cfg = cfgFor(root);
  const res = await fsMkdir(cfg, id, "", "newdir");
  assert.equal(res.path, "newdir");
  assert.equal((await stat(join(root, "newdir"))).isDirectory(), true);

  await assert.rejects(() => fsMkdir(cfg, id, "", "newdir"), /already exists|conflict/i);
});

test("mkdir rejects a traversing name", async () => {
  const root = await tmp();
  const id = slugifyId(basename(root));
  const cfg = cfgFor(root);
  await assert.rejects(() => fsMkdir(cfg, id, "", ".."), /invalid|path_escape/i);
  await assert.rejects(() => fsMkdir(cfg, id, "", "a/b"), /invalid|path_escape/i);
});
