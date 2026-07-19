import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileService } from "../src/git/fileService.js";
import { AuditLog } from "../src/util/audit.js";

const created: string[] = [];
async function setup(cap = 1024 * 1024): Promise<{ dir: string; fs: FileService; auditFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gv-fs-"));
  const adir = await mkdtemp(join(tmpdir(), "gv-fs-audit-"));
  created.push(dir, adir);
  const auditFile = join(adir, "audit.log");
  return { dir, fs: new FileService(cap, new AuditLog(auditFile)), auditFile };
}
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {}))));

test("create writes a new file (making parent dirs), then fails if it already exists", async () => {
  const { dir, fs } = await setup();
  await fs.create("t", dir, "sub/a.txt", "hello\n", "utf-8", "app");
  assert.equal(await readFile(join(dir, "sub", "a.txt"), "utf-8"), "hello\n");
  await assert.rejects(() => fs.create("t", dir, "sub/a.txt", "x", "utf-8", "app")); // wx → EEXIST
});

test("save overwrites existing working-tree content", async () => {
  const { dir, fs } = await setup();
  await fs.create("t", dir, "a.txt", "one\n", "utf-8", "app");
  await fs.save("t", dir, "a.txt", "two\n", "utf-8", "app");
  assert.equal(await readFile(join(dir, "a.txt"), "utf-8"), "two\n");
});

test("base64 content round-trips to exact bytes", async () => {
  const { dir, fs } = await setup();
  const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x0a]);
  await fs.create("t", dir, "b.bin", bytes.toString("base64"), "base64", "app");
  assert.deepEqual(await readFile(join(dir, "b.bin")), bytes);
});

test("rename moves a file; remove deletes it", async () => {
  const { dir, fs } = await setup();
  await fs.create("t", dir, "x.txt", "x", "utf-8", "app");
  await fs.renamePath("t", dir, "x.txt", "y/z.txt", "app");
  assert.equal(await readFile(join(dir, "y", "z.txt"), "utf-8"), "x");
  await assert.rejects(() => stat(join(dir, "x.txt"))); // source gone
  await fs.remove("t", dir, "y/z.txt", "app");
  await assert.rejects(() => stat(join(dir, "y", "z.txt"))); // deleted
});

test("writes over the size cap are rejected (too_large); under-cap is fine", async () => {
  const { dir, fs } = await setup(8); // 8-byte cap
  await assert.rejects(() => fs.create("t", dir, "big.txt", "123456789", "utf-8", "app"), /too_large|cap/i);
  await fs.create("t", dir, "ok.txt", "1234", "utf-8", "app");
  assert.equal(await readFile(join(dir, "ok.txt"), "utf-8"), "1234");
});

test("path traversal / absolute paths are rejected on every mutation", async () => {
  const { dir, fs } = await setup();
  await assert.rejects(() => fs.create("t", dir, "../escape.txt", "x", "utf-8", "app"), /path_escape|escaped|absolute/i);
  await assert.rejects(() => fs.save("t", dir, "/etc/passwd", "x", "utf-8", "app"), /absolute|path_escape/i);
  await assert.rejects(() => fs.renamePath("t", dir, "a", "../b", "app"), /path_escape|escaped/i);
  await assert.rejects(() => fs.remove("t", dir, "../../etc/hosts", "app"), /path_escape|escaped/i);
});

test("every write is appended to the audit log", async () => {
  const { dir, fs, auditFile } = await setup();
  await fs.create("t", dir, "a.txt", "x", "utf-8", "claude");
  await fs.save("t", dir, "a.txt", "y", "utf-8", "app");
  const lines = (await readFile(auditFile, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].action, "file.create");
  assert.equal(lines[0].actor, "claude");
  assert.equal(lines[1].action, "file.save");
  assert.ok(lines[0].ts, "entry carries a timestamp");
});
