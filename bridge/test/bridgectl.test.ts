import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * `gitview-bridgectl devices` / `revoke`. These operate on the token store DIRECTLY (see the script's
 * header), so they are testable without a running bridge — and they need to be: every finding in the
 * review of this feature was in the shell, the one surface with no coverage.
 *
 * GITVIEW_SUDO="" runs the script against a store the test user already owns; GITVIEW_NODE points at the
 * interpreter, matching how the .deb invokes it when node is outside the system PATH.
 */
const SCRIPT = new URL("../packaging/deb/gitview-bridgectl", import.meta.url).pathname;

const created: string[] = [];
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {}))));

async function fixture(store: unknown): Promise<{ dir: string; config: string; tokens: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gv-ctl-"));
  created.push(dir);
  const tokens = join(dir, "tokens.json");
  const config = join(dir, "config.yaml");
  await writeFile(tokens, JSON.stringify(store, null, 2), { mode: 0o600 });
  await writeFile(config, `port: 8787\nauth:\n  tokensFile: ${tokens}\n`);
  return { dir, config, tokens };
}

async function ctl(config: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await exec("sh", [SCRIPT, ...args], {
      env: { ...process.env, GITVIEW_CONFIG: config, GITVIEW_SUDO: "", GITVIEW_NODE: process.execPath },
    });
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

const device = (id: string, label: string) => ({
  id, label, createdAt: "2026-07-27T00:00:00.000Z", lastSeenAt: new Date().toISOString(),
  tokenHash: "a".repeat(64),
});

test("devices lists real devices and folds legacy tokens into one row", async () => {
  const { config } = await fixture({ devices: [device("dv_aaa", "Pixel 8")], tokens: ["t1", "t2", "t3"] });
  const { stdout, code } = await ctl(config, ["devices"]);
  assert.equal(code, 0);
  assert.match(stdout, /ID\s+NAME\s+LAST SEEN/, "prints a header");
  assert.match(stdout, /dv_aaa\s+Pixel 8/);
  assert.match(stdout, /legacy\s+unknown legacy device\(s\) \(3\)/, "legacy collapses with its count");
  assert.ok(!/connected/i.test(stdout), "must not claim a connected column it cannot know");
});

test("devices on an empty store says so rather than printing an empty table", async () => {
  const { config } = await fixture({ devices: [], tokens: [] });
  const { stdout } = await ctl(config, ["devices"]);
  assert.match(stdout, /No devices paired/);
});

test("revoke removes one device and leaves the rest", async () => {
  const { config, tokens } = await fixture({
    devices: [device("dv_aaa", "phone"), device("dv_bbb", "tablet")], tokens: ["t1"],
  });
  const { code } = await ctl(config, ["revoke", "dv_aaa"]);
  assert.equal(code, 0);
  const after = JSON.parse(await readFile(tokens, "utf-8")) as { devices: { id: string }[]; tokens: string[] };
  assert.deepEqual(after.devices.map((d) => d.id), ["dv_bbb"]);
  assert.deepEqual(after.tokens, ["t1"], "legacy tokens untouched");
});

test("revoke legacy drops every pre-ADR-035 token but no real device", async () => {
  const { config, tokens } = await fixture({ devices: [device("dv_aaa", "phone")], tokens: ["t1", "t2"] });
  await ctl(config, ["revoke", "legacy"]);
  const after = JSON.parse(await readFile(tokens, "utf-8")) as { devices: unknown[]; tokens: unknown[] };
  assert.deepEqual(after.tokens, []);
  assert.equal(after.devices.length, 1, "the real device survives");
});

test("revoke of an unknown id fails loudly and changes nothing", async () => {
  const { config, tokens } = await fixture({ devices: [device("dv_aaa", "phone")], tokens: [] });
  const before = await readFile(tokens, "utf-8");
  const { code, stderr } = await ctl(config, ["revoke", "dv_nope"]);
  assert.notEqual(code, 0, "must not report success");
  assert.match(stderr, /unknown device/);
  assert.equal(await readFile(tokens, "utf-8"), before, "store untouched");
});

test("revoke keeps the store owner-only and leaves no temp file behind", async () => {
  const { config, tokens, dir } = await fixture({ devices: [device("dv_aaa", "phone")], tokens: [] });
  await ctl(config, ["revoke", "dv_aaa"]);
  assert.equal((await stat(tokens)).mode & 0o777, 0o600, "0600 preserved — install -m 600, not cp+chmod");
  assert.deepEqual((await readdir(dir)).filter((f) => f.includes(".ctl.")), [], "no staging file left in the state dir");
});

test("concurrent revokes do not collide (a fixed temp path let one clobber the other)", async () => {
  // REGRESSION GUARD, not a proof. The lost update was demonstrated by hand against the first cut
  // (cat | node | install, with a constant temp path): revoking two devices concurrently left
  // ["dv_aaa","dv_ccc"] — one revocation silently dropped, leaving a revoked device authorised.
  // Doing the read and write inside ONE node process shrank that window to sub-millisecond, so this
  // test no longer fails even with flock removed. flock is kept because it closes the window properly;
  // this test only catches a future regression that widens it again.
  const ids = ["a", "b", "c", "d", "e", "f"].map((x) => "dv_" + x);
  const { config, tokens } = await fixture({
    devices: [...ids.map((id) => device(id, id)), device("dv_keep", "keep")], tokens: [],
  });
  await Promise.all(ids.map((id) => ctl(config, ["revoke", id])));
  const after = JSON.parse(await readFile(tokens, "utf-8")) as { devices: { id: string }[] };
  // BOTH revokes must land. The weaker "length <= 2" this started as passed even when one revoke was
  // silently lost — measured: revoking aaa and bbb concurrently left ["dv_aaa","dv_ccc"].
  assert.deepEqual(after.devices.map((d) => d.id), ["dv_keep"],
    "every revoke must survive — a lost update silently leaves a revoked device authorised");
});

test("a corrupt store is reported, not silently rewritten", async () => {
  const { config, tokens } = await fixture({});
  await writeFile(tokens, "{ not json", { mode: 0o600 });
  const list = await ctl(config, ["devices"]);
  assert.notEqual(list.code, 0);
  assert.match(list.stderr, /not valid JSON/);
  const rev = await ctl(config, ["revoke", "dv_aaa"]);
  assert.notEqual(rev.code, 0);
  assert.equal(await readFile(tokens, "utf-8"), "{ not json", "left exactly as found");
});
