import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confine } from "../src/util/paths.js";

async function tmpRoot(prefix = "gv-paths-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test("confine accepts in-repo paths (existing and to-be-created)", async () => {
  const root = await tmpRoot();
  await writeFile(join(root, "a.txt"), "hi");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "sub", "b.txt"), "hi");

  assert.equal(await confine(root, "a.txt"), join(root, "a.txt"));
  assert.equal(await confine(root, "sub/b.txt"), join(root, "sub", "b.txt"));
  // a not-yet-created file under an existing dir is allowed with mustExist=false
  assert.equal(await confine(root, "sub/new.txt", false), join(root, "sub", "new.txt"));
});

test("confine rejects `..` traversal", async () => {
  const root = await tmpRoot();
  await assert.rejects(() => confine(root, "../etc/passwd"), /path_escape|escaped/i);
  await assert.rejects(() => confine(root, "sub/../../escape"), /path_escape|escaped/i);
});

test("confine rejects absolute paths", async () => {
  const root = await tmpRoot();
  await assert.rejects(() => confine(root, "/etc/passwd"), /absolute/i);
});

test("confine rejects a symlink that escapes the root", async () => {
  const root = await tmpRoot();
  const outside = await tmpRoot("gv-outside-");
  await writeFile(join(outside, "secret"), "s");
  await symlink(outside, join(root, "link")); // root/link -> outside

  // reading through the symlink resolves outside the root -> reject
  await assert.rejects(() => confine(root, "link/secret"), /symlink|escaped|path_escape/i);
  await assert.rejects(() => confine(root, "link"), /symlink|escaped|path_escape/i);
});

test("confine allows an in-repo symlink that stays inside the root", async () => {
  const root = await tmpRoot();
  await mkdir(join(root, "real"), { recursive: true });
  await writeFile(join(root, "real", "f.txt"), "hi");
  await symlink(join(root, "real"), join(root, "alias")); // stays inside root
  assert.equal(await confine(root, "alias/f.txt"), join(root, "alias", "f.txt"));
});
