import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuthManager, LEGACY_DEVICE_ID } from "../src/auth/pairing.js";

// ADR-035: per-device tokens (`<id>.<secret>`), hashed at rest, revocable individually.

const created: string[] = [];
async function storeFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gv-dev-"));
  created.push(dir);
  return join(dir, "tokens.json");
}
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {}))));

async function pairOne(am: AuthManager, label?: string): Promise<string> {
  return am.pair(am.currentPairingCode, label);
}

test("a token is <id>.<secret> and resolves to the device that owns it", async () => {
  const am = new AuthManager(await storeFile());
  const token = await pairOne(am, "Pixel 8");

  const [id, secret] = token.split(".");
  assert.ok(id?.startsWith("dv_"), "id is prefixed");
  assert.ok((secret?.length ?? 0) >= 40, "secret is long");

  const who = am.authenticate(token);
  assert.equal(who?.id, id);
  assert.equal(who?.label, "Pixel 8");
  assert.equal(am.verify(token), true);
});

test("the secret is NEVER stored — only its sha256", async () => {
  const file = await storeFile();
  const am = new AuthManager(file);
  const token = await pairOne(am);
  const secret = token.slice(token.indexOf(".") + 1);

  const raw = await readFile(file, "utf-8");
  assert.ok(!raw.includes(secret), "the raw secret must not appear in the store");
  const parsed = JSON.parse(raw) as { devices: { tokenHash: string }[] };
  assert.match(parsed.devices[0]!.tokenHash, /^[0-9a-f]{64}$/, "sha256 hex is stored instead");
});

test("a tampered secret or an unknown id is rejected", async () => {
  const am = new AuthManager(await storeFile());
  const token = await pairOne(am);
  const [id, secret] = token.split(".");

  assert.equal(am.verify(`${id}.${secret}x`), false, "wrong secret (different length)");
  const flipped = secret!.slice(0, -1) + (secret!.at(-1) === "A" ? "B" : "A");
  assert.equal(am.verify(`${id}.${flipped}`), false, "wrong secret (same length)");
  assert.equal(am.verify(`dv_nope.${secret}`), false, "unknown id");
  assert.equal(am.verify(`${id}.`), false, "empty secret");
  assert.equal(am.verify(id), false, "id alone is not a token");
});

test("revoking one device leaves the others working", async () => {
  const am = new AuthManager(await storeFile());
  const a = await pairOne(am, "phone");
  const b = await pairOne(am, "tablet");

  const aId = a.split(".")[0]!;
  assert.equal(await am.revoke(aId), true);
  assert.equal(am.verify(a), false, "revoked device is out");
  assert.equal(am.verify(b), true, "the other device is untouched");
  assert.equal(am.list().length, 1);
});

test("revoking an unknown id reports false (so the route can 404)", async () => {
  const am = new AuthManager(await storeFile());
  await pairOne(am);
  assert.equal(await am.revoke("dv_missing"), false);
});

test("list() exposes labels and timestamps but never the hash", async () => {
  const am = new AuthManager(await storeFile());
  await pairOne(am, "Pixel 8");
  const [d] = am.list();
  assert.equal(d?.label, "Pixel 8");
  assert.ok(d?.createdAt && d.lastSeenAt, "timestamps present");
  assert.equal((d as Record<string, unknown>)["tokenHash"], undefined, "hash must not leak");
});

test("labels are sanitized: control chars stripped, length capped, blank falls back", async () => {
  const am = new AuthManager(await storeFile());
  await pairOne(am, "  ok\u0000\u001b name  ");
  await pairOne(am, "   ");
  await pairOne(am, "x".repeat(200));
  const labels = am.list().map((d) => d.label);
  assert.equal(labels[0], "ok name", "control chars removed, trimmed");
  assert.equal(labels[1], "device", "blank label falls back");
  assert.equal(labels[2]!.length, 64, "capped");
});

test("lastSeenAt advances when a device authenticates", async () => {
  const am = new AuthManager(await storeFile());
  const token = await pairOne(am);
  const first = am.list()[0]!.lastSeenAt;
  await new Promise((r) => setTimeout(r, 5));
  am.authenticate(token);
  assert.notEqual(am.list()[0]!.lastSeenAt, first);
  await am.close();
});

// ---- migration: pre-ADR-035 stores must keep working -------------------------

test("legacy bare tokens still verify, and report the shared legacy id", async () => {
  const file = await storeFile();
  await writeFile(file, JSON.stringify({ tokens: ["oldToken1", "oldToken2"] }), { mode: 0o600 });

  const am = new AuthManager(file);
  await am.load();
  assert.equal(am.verify("oldToken1"), true, "no forced re-pair on upgrade");
  assert.equal(am.authenticate("oldToken2")?.id, LEGACY_DEVICE_ID);
  assert.equal(am.verify("notAToken"), false);
});

test("legacy tokens survive alongside a newly paired device, and revoke together", async () => {
  const file = await storeFile();
  await writeFile(file, JSON.stringify({ tokens: ["oldToken1"] }), { mode: 0o600 });

  const am = new AuthManager(file);
  await am.load();
  const fresh = await pairOne(am, "new phone");

  assert.equal(am.list().length, 2, "one real device + one synthetic legacy entry");
  assert.ok(am.list().some((d) => d.legacy), "legacy entry is flagged");

  assert.equal(await am.revoke(LEGACY_DEVICE_ID), true);
  assert.equal(am.verify("oldToken1"), false, "all legacy tokens dropped at once");
  assert.equal(am.verify(fresh), true, "the real device is unaffected");
  assert.equal(await am.revoke(LEGACY_DEVICE_ID), false, "nothing left to revoke");
});

test("devices persist across a restart and the file stays 0600", async () => {
  const file = await storeFile();
  const am1 = new AuthManager(file);
  const token = await pairOne(am1, "phone");

  // tmp+rename must not widen the mode (rename preserves the tmp file's 0600).
  assert.equal((await stat(file)).mode & 0o777, 0o600, "store must stay owner-only");

  const am2 = new AuthManager(file);
  await am2.load();
  assert.equal(am2.verify(token), true);
  assert.equal(am2.list()[0]?.label, "phone");
});

test("concurrent store writes serialize — no lost update, no ENOENT, no stray tmp", async () => {
  const file = await storeFile();
  const am = new AuthManager(file);

  const tokens: string[] = [];
  for (let i = 0; i < 5; i++) tokens.push(await pairOne(am, `dev${i}`));

  // Revoke every device at once. Each revoke persists, so these writes overlap; a shared tmp path
  // would interleave as write→write→rename→rename and the second rename would fail ENOENT.
  const ids = tokens.map((t) => t.split(".")[0]!);
  const results = await Promise.allSettled(ids.map((id) => am.revoke(id)));
  assert.ok(results.every((r) => r.status === "fulfilled"), "no write rejected");
  assert.ok(results.every((r) => r.status === "fulfilled" && r.value === true), "each revoke found its device");

  // The last write standing must be a complete, parseable store reflecting every revoke.
  const raw = JSON.parse(await readFile(file, "utf-8")) as { devices: unknown[] };
  assert.equal(raw.devices.length, 0, "all revokes landed — no lost update");
  assert.equal(am.list().length, 0);
  for (const t of tokens) assert.equal(am.verify(t), false);

  const leftovers = (await readdir(dirname(file))).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no temp files left behind");
});

test("refreshPairingCode does not disturb already-paired devices", async () => {
  const am = new AuthManager(await storeFile());
  const existing = await pairOne(am, "phone");
  am.refreshPairingCode();
  assert.equal(am.verify(existing), true);
  const second = await pairOne(am, "tablet");
  assert.equal(am.verify(second), true);
  assert.equal(am.list().length, 2);
});

// ---- out-of-band edits (gitview-bridgectl devices/revoke) --------------------

test("reload() re-reads the store and reports which devices vanished", async () => {
  const file = await storeFile();
  const am = new AuthManager(file);
  const a = await pairOne(am, "phone");
  const b = await pairOne(am, "tablet");
  const aId = a.split(".")[0]!;

  // Simulate `gitview-bridgectl revoke <aId>`: an external process edits the file directly.
  const raw = JSON.parse(await readFile(file, "utf-8")) as { devices: { id: string }[]; tokens: string[] };
  raw.devices = raw.devices.filter((d) => d.id !== aId);
  await writeFile(file, JSON.stringify(raw), { mode: 0o600 });

  const gone = await am.reload();
  assert.deepEqual(gone, [aId], "reports exactly the device that disappeared");
  assert.equal(am.verify(a), false, "the externally-revoked token stops working without a restart");
  assert.equal(am.verify(b), true, "the other device is unaffected");
});

test("reload() reports the legacy bucket when it is cleared out of band", async () => {
  const file = await storeFile();
  await writeFile(file, JSON.stringify({ tokens: ["old1", "old2"] }), { mode: 0o600 });
  const am = new AuthManager(file);
  await am.load();
  assert.equal(am.verify("old1"), true);

  await writeFile(file, JSON.stringify({ devices: [], tokens: [] }), { mode: 0o600 });
  const gone = await am.reload();
  assert.deepEqual(gone, [LEGACY_DEVICE_ID]);
  assert.equal(am.verify("old1"), false);
});

test("a flush landing BEFORE reload resurrects the device — the documented race, not a fix", async () => {
  // Verified by removing the guard in reload(): the suite stayed green, because once reload() replaces
  // the maps a late flush writes POST-reload state and can't resurrect anything. The real window is the
  // other side of the signal, and reload cannot close it. Pinned here so the limitation is visible in
  // the suite rather than only in a comment — if someone makes the flush merge instead of overwrite,
  // this test should start failing and be updated.
  const file = await storeFile();
  const am = new AuthManager(file);
  const token = await pairOne(am, "phone");
  am.authenticate(token); // in-memory store is now dirty and still holds the device

  // External revoke (what the CLI does)…
  await writeFile(file, JSON.stringify({ devices: [], tokens: [] }), { mode: 0o600 });
  // …but a coalesced flush wins the race and writes the pre-edit list back.
  await am.close();

  const after = JSON.parse(await readFile(file, "utf-8")) as { devices: unknown[] };
  assert.equal(after.devices.length, 1, "the device is back — this is the race the CLI narrows, not removes");
  assert.equal(am.verify(token), true);
});

test("reload() reports nothing when the store is unchanged", async () => {
  const am = new AuthManager(await storeFile());
  await pairOne(am, "phone");
  assert.deepEqual(await am.reload(), []);
});

test("reload() on an UNREADABLE store changes nothing — it must not read as 'all revoked'", async () => {
  // This is the bug that wiped a live store. A CLI revoke run under sudo left the file root-owned; the
  // bridge (running as the install user) hit EACCES; load() swallowed it; reload() had already cleared
  // the maps, so every device — including a real phone and 21 legacy tokens — reported as revoked.
  const file = await storeFile();
  const am = new AuthManager(file);
  const token = await pairOne(am, "phone");
  await writeFile(file, "{ this is not json", { mode: 0o600 });

  await assert.rejects(() => am.reload(), /refusing to reload/, "must refuse rather than silently empty");
  assert.equal(am.verify(token), true, "the device is STILL authorised — nothing was revoked");
  assert.equal(am.list().length, 1);
});

test("reload() surfaces a missing store as a failure, not as a mass revocation", async () => {
  const file = await storeFile();
  const am = new AuthManager(file);
  const token = await pairOne(am, "phone");
  await rm(file, { force: true });

  await assert.rejects(() => am.reload(), /refusing to reload/);
  assert.equal(am.verify(token), true, "a vanished file must not revoke every device");
});
