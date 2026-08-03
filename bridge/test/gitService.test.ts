import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRef, listTree, readBlob, blobExists, diff, repoState, WORKTREE } from "../src/git/gitService.js";

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

test("worktree diff includes untracked files but leaves the real .git/index untouched", async () => {
  const repo = await makeRepo();
  await writeFile(join(repo, "new.txt"), "brand new\n"); // untracked — plain `git diff` would skip it
  const idx = join(repo, ".git", "index");
  const before = (await stat(idx)).mtimeMs;
  const d = await diff(repo, "worktree", WORKTREE, undefined);
  assert.match(d, /new file/);
  assert.match(d, /\+brand new/);
  // the real index must not change (else the repo watcher loops: repo.changed → refetch → mutate → …)
  assert.equal((await stat(idx)).mtimeMs, before);
  // and nothing persists — the file is still untracked, not intent-to-add
  assert.match((await exec("git", ["-C", repo, "status", "--porcelain"])).stdout, /\?\? new\.txt/);
});

test("repoState reports the unborn branch name (not 'HEAD') on an empty repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gv-git-empty-"));
  created.push(dir);
  await exec("git", ["-C", dir, "init", "-q", "-b", "trunk"]);
  const st = await repoState(dir);
  assert.equal(st.branch, "trunk");
  assert.equal(st.dirty, 0);
});

test("commit diff renders a merge as a 2-way diff, not combined (--cc)", async () => {
  const repo = await makeRepo();
  const g = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  // Two branches change the SAME line differently, then a conflict resolution merge.
  await writeFile(join(repo, "m.txt"), "l1\nl2\nl3\n");
  await g("add", "-A"); await g("commit", "-qm", "base");
  await g("branch", "-M", "main");
  await g("checkout", "-qb", "br");
  await writeFile(join(repo, "m.txt"), "l1\nBRANCH\nl3\n");
  await g("commit", "-qam", "br");
  await g("checkout", "-q", "main");
  await writeFile(join(repo, "m.txt"), "l1\nMAIN\nl3\n");
  await g("commit", "-qam", "main");
  await g("merge", "br").catch(() => {}); // conflicts, leaves the tree unmerged
  await writeFile(join(repo, "m.txt"), "l1\nRESOLVED\nl3\n");
  await g("add", "-A"); await g("commit", "-qm", "merge br");
  const { stdout: parents } = await g("rev-list", "--parents", "-n", "1", "HEAD");
  assert.equal(parents.trim().split(/\s+/).length, 3, "HEAD must be a real merge commit");

  const out = await diff(repo, "commit", "HEAD", undefined);
  // git's default `git show` on a merge is combined; the bridge must force 2-way first-parent.
  assert.ok(!out.includes("diff --cc") && !out.includes("@@@"), "must not be a combined diff");
  assert.match(out, /^@@ -\d+,?\d* \+\d+,?\d* @@/m, "must have a 2-way hunk header");
  assert.match(out, /^-MAIN$/m, "removed first-parent line, single-column prefix");
  assert.match(out, /^\+RESOLVED$/m, "added merge-result line, single-column prefix");
});

/**
 * `blobExists` — the cheap existence check cross-probe leans on (ADR-038, Phase 3b).
 *
 * It answers "is there a `.kicad_pcb` beside this `.kicad_sch`" without reading the file, which matters
 * because a board can be 128 MB and the question is worth one bit. It also has to stay as quiet as
 * `readBlob` about hidden and ignored paths: a caller must not be able to use it to probe for
 * `.gitview/tokens.json`.
 */
test("blobExists answers without reading, and stays quiet about hidden paths", async () => {
  const dir = await makeRepo();
  const oid = await resolveRef(dir, undefined);

  assert.equal(await blobExists(dir, oid, "a.txt"), true);
  assert.equal(await blobExists(dir, oid, "nope.txt"), false, "absent file is a plain no");

  // The secrets `readBlob` refuses to serve must not become discoverable through an existence probe.
  assert.equal(await blobExists(dir, WORKTREE, ".gitview/tokens.json"), false, "hidden dir stays hidden");
  assert.equal(await blobExists(dir, WORKTREE, "node_modules/pkg/index.js"), false, "ignored stays ignored");

  // Traversal is refused rather than answered — same confinement as every other content-driven path.
  assert.equal(await blobExists(dir, oid, "../../../etc/passwd"), false);
  assert.equal(await blobExists(dir, WORKTREE, "../../../etc/passwd"), false);

  // A directory is not a blob.
  assert.equal(await blobExists(dir, WORKTREE, "node_modules"), false);
});

test("blobExists sees the working tree, not only the commit", async () => {
  // Cross-probe has to work on an unsaved board too — the file exists on disk before it is committed, and
  // saying "no counterpart" there would make the action vanish exactly while someone is editing.
  const dir = await makeRepo();
  await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb)\n");
  assert.equal(await blobExists(dir, WORKTREE, "board.kicad_pcb"), true, "uncommitted file is visible");
  const oid = await resolveRef(dir, "HEAD");
  assert.equal(await blobExists(dir, oid, "board.kicad_pcb"), false, "but not at the commit that predates it");
});
