import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWrite } from "../src/git/gitWrite.js";
import { AuditLog } from "../src/util/audit.js";

const exec = promisify(execFile);
const created: string[] = [];
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {}))));

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gv-gw-"));
  created.push(dir);
  await exec("git", ["-C", dir, "init", "-q"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, "a.txt"), "one\n");
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", ["-C", dir, "commit", "-qm", "init"]);
  return dir;
}

/** Audit log lives OUTSIDE the repo so it doesn't dirty `git status` in these tests. */
async function gitWriteFor(): Promise<{ gw: GitWrite; auditFile: string }> {
  const adir = await mkdtemp(join(tmpdir(), "gv-gw-audit-"));
  created.push(adir);
  const auditFile = join(adir, "audit.log");
  return { gw: new GitWrite(new AuditLog(auditFile)), auditFile };
}

const log = async (dir: string) => (await exec("git", ["-C", dir, "log", "--oneline"])).stdout.trim().split("\n");
const porcelain = async (dir: string) => (await exec("git", ["-C", dir, "status", "--porcelain"])).stdout.trim();

test("stage + commit creates a commit and returns its oid; tree ends clean", async () => {
  const dir = await makeRepo();
  const { gw } = await gitWriteFor();
  await writeFile(join(dir, "b.txt"), "new\n");
  await gw.stage("t", dir, ["b.txt"], "app");
  const res = await gw.commit("t", dir, "add b", undefined, "app");
  assert.match(res.oid ?? "", /^[0-9a-f]{40,64}$/);
  const l = await log(dir);
  assert.equal(l.length, 2);
  assert.match(l[0], /add b/);
  assert.equal(await porcelain(dir), "");
});

test("commit with an empty/whitespace message is rejected", async () => {
  const dir = await makeRepo();
  const { gw } = await gitWriteFor();
  await writeFile(join(dir, "a.txt"), "changed\n");
  await gw.stage("t", dir, ["a.txt"], "app");
  await assert.rejects(() => gw.commit("t", dir, "   ", undefined, "app"), /message is required/i);
});

test("discard restores staged + worktree changes", async () => {
  const dir = await makeRepo();
  const { gw } = await gitWriteFor();
  await writeFile(join(dir, "a.txt"), "changed\n");
  await gw.stage("t", dir, ["a.txt"], "app");
  await gw.discard("t", dir, ["a.txt"], "app");
  assert.equal(await readFile(join(dir, "a.txt"), "utf-8"), "one\n"); // restored
  assert.equal(await porcelain(dir), "");
});

test("stage/discard paths are confined", async () => {
  const dir = await makeRepo();
  const { gw } = await gitWriteFor();
  await assert.rejects(() => gw.stage("t", dir, ["../evil"], "app"), /path_escape|escaped/i);
  await assert.rejects(() => gw.discard("t", dir, ["/etc/passwd"], "app"), /absolute|path_escape/i);
});

test("stage + commit are audited (with the commit message as detail)", async () => {
  const dir = await makeRepo();
  const { gw, auditFile } = await gitWriteFor();
  await writeFile(join(dir, "b.txt"), "x\n");
  await gw.stage("t", dir, ["b.txt"], "app");
  await gw.commit("t", dir, "msg", undefined, "app");
  const lines = (await readFile(auditFile, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l: { action: string }) => l.action), ["stage", "commit"]);
  assert.equal(lines[1].detail, "msg");
});
