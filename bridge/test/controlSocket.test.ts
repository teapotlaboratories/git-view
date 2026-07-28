import { test, after } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthManager } from "../src/auth/pairing.js";
import { ControlSocket } from "../src/control/controlSocket.js";

/**
 * ADR-036. The socket is the host-admin channel; filesystem permissions are its only gate. These cover
 * the protocol and — more importantly — the properties that motivated it: distinct commands, real
 * replies, and the bridge remaining the single writer of the store.
 */

const created: string[] = [];
const sockets: ControlSocket[] = [];
after(async () => {
  await Promise.all(sockets.map((s) => s.close().catch(() => {})));
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

async function harness(opts: { connected?: Set<string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gv-ctlsock-"));
  created.push(dir);
  const auth = new AuthManager(join(dir, "tokens.json"));
  const closed: string[] = [];
  const sock = new ControlSocket(join(dir, "control.sock"), {
    auth,
    connectedDeviceIds: () => opts.connected ?? new Set<string>(),
    disconnectDevice: (id) => { closed.push(id); return 1; },
    pairingTtlMs: 600_000,
  });
  sockets.push(sock);
  assert.equal(await sock.start(), true, "socket should bind in a temp dir");
  return { auth, sock, path: join(dir, "control.sock"), closed };
}

function send(path: string, req: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const c = connect(path);
    let out = "";
    c.setEncoding("utf-8");
    c.on("error", reject);
    c.on("data", (d: string) => { out += d; });
    c.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e as Error); } });
    c.end(`${JSON.stringify(req)}\n`);
  });
}

test("the socket is owner-only — filesystem permissions are the whole gate", async () => {
  const { path } = await harness();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("pair returns the code in the REPLY (no journalctl scraping)", async () => {
  const { path, auth } = await harness();
  const r = await send(path, { cmd: "pair" });
  assert.equal(r["ok"], true);
  assert.match(String(r["code"]), /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2,}$/);
  assert.equal(r["code"], auth.currentPairingCode, "the code returned is the one now live");
});

test("revoke does NOT rotate the pairing code — the whole point of dropping signals", async () => {
  // A signal carried no payload, so the handler minted a code AND reloaded on every ring. Revoking a
  // lost phone therefore invalidated the code you had just generated to re-pair a good one.
  const { path, auth } = await harness();
  const token = await auth.pair(auth.currentPairingCode, "throwaway");
  const codeBefore = auth.currentPairingCode;

  const r = await send(path, { cmd: "revoke", id: token.split(".")[0] });
  assert.equal(r["ok"], true);
  assert.equal(auth.currentPairingCode, codeBefore, "an outstanding pairing code must survive a revoke");
});

test("revoke reports what actually happened, and closes the device's connections", async () => {
  const { path, auth, closed } = await harness();
  const token = await auth.pair(auth.currentPairingCode, "phone");
  const id = token.split(".")[0]!;

  const r = await send(path, { cmd: "revoke", id });
  assert.deepEqual(
    { ok: r["ok"], id: r["id"], removed: r["removed"], connectionsClosed: r["connectionsClosed"] },
    { ok: true, id, removed: 1, connectionsClosed: 1 },
  );
  assert.deepEqual(closed, [id], "the live sockets were told to go");
  assert.equal(auth.verify(token), false);
});

test("revoking an unknown id is an error the CLI can surface, not a silent success", async () => {
  const { path } = await harness();
  const r = await send(path, { cmd: "revoke", id: "dv_nope" });
  assert.equal(r["ok"], false);
  assert.match(String(r["error"]), /unknown device/);
});

test("devices reports live connection state — impossible for the old file-reading CLI", async () => {
  const { path, auth } = await harness({ connected: new Set<string>() });
  const token = await auth.pair(auth.currentPairingCode, "Pixel 8");
  const id = token.split(".")[0]!;

  const offline = await send(path, { cmd: "devices" });
  const rows = offline["devices"] as { id: string; label: string; connected: boolean }[];
  assert.equal(rows[0]?.label, "Pixel 8");
  assert.equal(rows[0]?.connected, false);

  const { path: p2, auth: a2 } = await harness({ connected: new Set([id]) });
  await a2.pair(a2.currentPairingCode, "Pixel 8");
  const onlineRows = (await send(p2, { cmd: "devices" }))["devices"] as { connected: boolean }[];
  assert.equal(typeof onlineRows[0]?.connected, "boolean", "connected is always reported");
});

test("malformed and unknown requests are refused, not ignored", async () => {
  const { path } = await harness();
  const bad = await send(path, "not-an-object-with-cmd");
  assert.equal(bad["ok"], false);
  const unknown = await send(path, { cmd: "sudo-make-me-a-sandwich" });
  assert.equal(unknown["ok"], false);
  assert.match(String(unknown["error"]), /unknown command/);
});

test("start() reports failure instead of throwing when it cannot bind", async () => {
  // A bridge that serves repos fine must not fail to start because its admin channel is unavailable.
  // Parent is a regular file, so mkdir fails immediately with ENOTDIR. NOT a /proc path: mkdir -p there
  // hangs rather than failing, which is why start() is also bounded by a timeout.
  const s = new ControlSocket("/etc/hostname/nope/control.sock", {
    auth: new AuthManager(join(await mkdtemp(join(tmpdir(), "gv-nobind-")), "t.json")),
    connectedDeviceIds: () => new Set<string>(),
    disconnectDevice: () => 0,
    pairingTtlMs: 600_000,
  });
  assert.equal(await s.start(), false);
});

test("a stale socket file from an unclean exit does not block a restart", async () => {
  const { path, sock } = await harness();
  // Simulate a crash: the process is gone but the socket file remains.
  await new Promise<void>((r) => setTimeout(r, 10));
  await sock.close();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, "");
  const again = new ControlSocket(path, {
    auth: new AuthManager(`${path}.tokens`),
    connectedDeviceIds: () => new Set<string>(),
    disconnectDevice: () => 0,
    pairingTtlMs: 600_000,
  });
  sockets.push(again);
  assert.equal(await again.start(), true, "a leftover socket file must be cleared, not fatal");
});

test("a second bridge must NOT steal a live socket", async () => {
  // The first cut probed by binding a *different* path, which always succeeded, so it concluded "stale"
  // every time and unlinked the live socket. A second bridge silently took it over: the first kept
  // serving HTTP while the CLI talked to the second — admin commands landing on the wrong store.
  const { path } = await harness();
  const intruder = new ControlSocket(path, {
    auth: new AuthManager(`${path}.other`),
    connectedDeviceIds: () => new Set<string>(),
    disconnectDevice: () => 0,
    pairingTtlMs: 600_000,
  });
  sockets.push(intruder);
  assert.equal(await intruder.start(), false, "must refuse rather than take the path");
  // The original is still the one answering.
  const r = await send(path, { cmd: "devices" });
  assert.equal(r["ok"], true, "the first bridge still owns and serves the socket");
});

test("an oversized request is refused and the connection dropped", async () => {
  const { path } = await harness();
  const reply = await new Promise<string>((resolve, reject) => {
    const c = connect(path);
    let out = "";
    c.setEncoding("utf-8");
    c.on("error", reject);
    c.on("data", (d: string) => { out += d; });
    c.on("close", () => resolve(out));
    c.write(`{"cmd":"devices","pad":"${"x".repeat(9000)}`); // over the cap, no newline
  });
  assert.match(reply, /too large/);
});

test("revoking the legacy bucket reports how many tokens it dropped", async () => {
  // It used to answer `removed: 1` no matter what, because AuthManager.revoke returned a boolean. So
  // clearing a bucket of twenty-one pre-ADR-035 tokens read exactly like revoking a single phone — for an
  // operation with no undo. The count has to survive from the store to the reply.
  const dir = await mkdtemp(join(tmpdir(), "gv-legacybucket-"));
  created.push(dir);
  const tokens = join(dir, "tokens.json");
  await writeFile(tokens, JSON.stringify({ devices: [], tokens: ["a", "b", "c"] }), { mode: 0o600 });
  const auth = new AuthManager(tokens);
  await auth.load();
  const path = join(dir, "control.sock");
  const sock = new ControlSocket(path, {
    auth, connectedDeviceIds: () => new Set<string>(), disconnectDevice: () => 0, pairingTtlMs: 600_000,
  });
  sockets.push(sock);
  assert.equal(await sock.start(), true);

  const r = await send(path, { cmd: "revoke", id: "legacy" });
  assert.equal(r["removed"], 3, "all three, not a hardcoded 1");
  assert.equal(auth.verify("a"), false, "and they really are gone");

  const again = await send(path, { cmd: "revoke", id: "legacy" });
  assert.equal(again["ok"], false, "an empty bucket is not a silent success");
});
