import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRef, listTree, readBlob, WORKTREE } from "../src/git/gitService.js";

const exec = promisify(execFile);
const created: string[] = [];
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {}))));

/** A throwaway git repo with a tracked file, an ignored dir, and a `.gitview` secret dir. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gv-git-"));
  created.push(dir);
  await exec("git", ["-C", dir, "init", "-q"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, ".gitignore"), "node_modules/\n");
  await writeFile(join(dir, "a.txt"), "hello\n");
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(dir, "node_modules", "pkg", "index.js"), "x\n");
  await mkdir(join(dir, ".gitview"), { recursive: true });
  await writeFile(join(dir, ".gitview", "tokens.json"), "SECRET\n");
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", ["-C", dir, "commit", "-qm", "init"]);
  return dir;
}

test("resolveRef rejects option-like and malformed refs", async () => {
  const repo = await makeRepo();
  for (const bad of ["-x", "--all", "a b", "a~1", "a^", "re:f", "a*", "a?b", "a[b]"]) {
    await assert.rejects(() => resolveRef(repo, bad), new RegExp("invalid ref|not found"));
  }
});

test("resolveRef resolves WORKTREE and HEAD", async () => {
  const repo = await makeRepo();
  assert.equal(await resolveRef(repo, WORKTREE), WORKTREE);
  assert.equal(await resolveRef(repo, undefined), WORKTREE);
  assert.match(await resolveRef(repo, "HEAD"), /^[0-9a-f]{40,64}$/); // SHA-1 or SHA-256
});

test("working-tree browse hides .git/.gitview/ignored, serves normal files", async () => {
  const repo = await makeRepo();
  const root = await listTree(repo, WORKTREE, "");
  const names = root.entries.map((e) => e.name);
  assert.ok(!names.includes(".git"), "root must not list .git");
  assert.ok(!names.includes(".gitview"), "root must not list .gitview");
  assert.ok(!names.includes("node_modules"), "root must not list ignored node_modules");
  assert.ok(names.includes("a.txt"), "root must list a tracked file");
});

test("listing INSIDE a hidden/ignored dir returns not_found", async () => {
  const repo = await makeRepo();
  await assert.rejects(() => listTree(repo, WORKTREE, ".git"), /not_found|not found/);
  await assert.rejects(() => listTree(repo, WORKTREE, ".gitview"), /not_found|not found/);
  await assert.rejects(() => listTree(repo, WORKTREE, "node_modules"), /not_found|not found/);
});

test("readBlob blocks secret/ignored paths but serves normal files", async () => {
  const repo = await makeRepo();
  await assert.rejects(() => readBlob(repo, WORKTREE, ".gitview/tokens.json"), /not_found|not found/);
  await assert.rejects(() => readBlob(repo, WORKTREE, "node_modules/pkg/index.js"), /not_found|not found/);
  const blob = await readBlob(repo, WORKTREE, "a.txt");
  assert.equal(blob.binary, false);
  assert.equal(blob.encoding, "utf-8");
  assert.equal(blob.content, "hello\n");
});

test("readBlob returns base64 for binary content (NUL bytes)", async () => {
  const repo = await makeRepo();
  await writeFile(join(repo, "b.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
  const blob = await readBlob(repo, WORKTREE, "b.bin");
  assert.equal(blob.binary, true);
  assert.equal(blob.encoding, "base64");
  assert.equal(Buffer.from(blob.content, "base64").length, 5);
});
