import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { AuthManager } from "../src/auth/pairing.js";
import { ControlSocket } from "../src/control/controlSocket.js";

const exec = promisify(execFile);

/**
 * `gitview-bridgectl` end to end, against a real control socket (ADR-036).
 *
 * These used to drive the CLI against a token FILE, because that is what it edited. It no longer does:
 * the bridge is the single writer and the CLI just asks it. The tests moved with the design — they now
 * assert the CLI's half of the protocol, including the case that has no answer any more (a bridge that
 * is not running).
 *
 * GITVIEW_SUDO="" runs it against a socket the test user already owns; GITVIEW_NODE points at the
 * interpreter, matching how the .deb invokes it when node is outside the system PATH.
 */
const SCRIPT = new URL("../packaging/deb/gitview-bridgectl", import.meta.url).pathname;

const created: string[] = [];
const sockets: ControlSocket[] = [];
after(async () => {
  await Promise.all(sockets.map((s) => s.close().catch(() => {})));
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** A config the CLI can read, plus (unless `noBridge`) a live socket behind it. */
async function bridge(opts: { noBridge?: boolean; connected?: Set<string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gv-ctl-"));
  created.push(dir);
  const sockPath = join(dir, "control.sock");
  const tokens = join(dir, "tokens.json");
  const config = join(dir, "config.yaml");
  await writeFile(config, `port: 8787\nauth:\n  tokensFile: ${tokens}\n  controlSocket: ${sockPath}\n`);

  const auth = new AuthManager(tokens);
  if (!opts.noBridge) {
    const sock = new ControlSocket(sockPath, {
      auth,
      connectedDeviceIds: () => opts.connected ?? new Set<string>(),
      disconnectDevice: () => 1,
      pairingTtlMs: 600_000,
    });
    sockets.push(sock);
    assert.equal(await sock.start(), true);
  }
  return { dir, config, auth, sockPath, tokens };
}

async function ctl(
  config: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await exec("sh", [SCRIPT, ...args], {
      env: { ...process.env, GITVIEW_CONFIG: config, GITVIEW_SUDO: "", GITVIEW_NODE: process.execPath, ...extraEnv },
    });
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

test("devices lists what the bridge reports, including connected state", async () => {
  const { config, auth } = await bridge();
  await auth.pair(auth.currentPairingCode, "Pixel 8");
  const { stdout, code } = await ctl(config, ["devices"]);
  assert.equal(code, 0);
  assert.match(stdout, /ID\s+NAME\s+CONNECTED\s+LAST SEEN/, "connected is back — the socket can answer it");
  assert.match(stdout, /Pixel 8\s+no/);
});

test("devices folds legacy tokens into one row", async () => {
  const { config, dir, sockPath, tokens } = await bridge({ noBridge: true });
  await writeFile(tokens, JSON.stringify({ devices: [], tokens: ["a", "b", "c"] }), { mode: 0o600 });
  const auth = new AuthManager(tokens);
  await auth.load();
  const sock = new ControlSocket(sockPath, {
    auth, connectedDeviceIds: () => new Set<string>(), disconnectDevice: () => 0, pairingTtlMs: 600_000,
  });
  sockets.push(sock);
  assert.equal(await sock.start(), true);
  assert.ok(dir);
  assert.match((await ctl(config, ["devices"])).stdout, /legacy\s+unknown legacy device\(s\) \(3\)/);
});

test("devices on an empty bridge says so", async () => {
  const { config } = await bridge();
  assert.match((await ctl(config, ["devices"])).stdout, /No devices paired/);
});

test("revoke removes the device and reports the connections the BRIDGE closed", async () => {
  const { config, auth } = await bridge();
  const token = await auth.pair(auth.currentPairingCode, "phone");
  const id = token.split(".")[0]!;
  const { stdout, code } = await ctl(config, ["revoke", id]);
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`Revoked ${id} \\(1 connection`), "reports what happened, not a guess");
  assert.equal(auth.verify(token), false, "the bridge's own store is updated — no second writer");
});

test("revoke does not disturb a pending pairing code", async () => {
  // The reason signals were dropped: one carried no payload, so revoking also minted a new code and
  // invalidated the one you had just generated to re-pair a good phone.
  const { config, auth } = await bridge();
  const token = await auth.pair(auth.currentPairingCode, "throwaway");
  const code = auth.currentPairingCode;
  await ctl(config, ["revoke", token.split(".")[0]!]);
  assert.equal(auth.currentPairingCode, code, "revoking must not burn the code you are about to type");
});

test("revoke of an unknown id fails loudly", async () => {
  const { config } = await bridge();
  const { code, stderr } = await ctl(config, ["revoke", "dv_nope"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /unknown device/);
});

test("pair returns a code from the bridge, not from the journal", async () => {
  const { config, auth } = await bridge();
  const { stdout, code } = await ctl(config, ["pair"]);
  assert.equal(code, 0);
  const printed = /([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2,})/.exec(stdout)?.[1];
  assert.equal(printed, auth.currentPairingCode, "the code printed is the one the bridge now holds");
});

test("the socket check is made by the privileged process, not by you", async () => {
  // On a stock install the bridge runs as its own user and /run/gitview-bridge is 0700, so an operator
  // cannot stat inside it. The first cut guarded with a plain `[ -S "$SOCK" ]` run unprivileged, so every
  // command answered "bridge is not running" while the bridge was running fine and the sudo'd line right
  // below would have connected — worse, it then advised `start`, which is a no-op on a running service.
  //
  // Simulated here without root: the socket sits in a directory this user cannot traverse, and
  // GITVIEW_SUDO stands in for sudo — it opens the directory only for the duration of the command, so
  // anything the script decides OUTSIDE that call still sees the locked directory, exactly as sudo does.
  const { config, auth, sockPath } = await bridge();
  await auth.pair(auth.currentPairingCode, "Pixel 8");
  const dir = dirname(sockPath);
  const stub = join(dir, "..", "sudo-stub.sh");
  await writeFile(stub, `#!/bin/sh\nchmod 0700 '${dir}'\n"$@"\nrc=$?\nchmod 0000 '${dir}'\nexit $rc\n`, { mode: 0o755 });
  await chmod(dir, 0o000);
  try {
    const { stdout, code } = await ctl(config, ["devices"], { GITVIEW_SUDO: stub });
    assert.equal(code, 0, "a running bridge must not be reported as down just because you can't see it");
    assert.match(stdout, /Pixel 8/);
  } finally {
    await chmod(dir, 0o700); // so the after() cleanup can remove it
  }
});

test("with no bridge running, every command fails clearly instead of pretending", async () => {
  // The cost the socket introduces, and it must be visible: the CLI can no longer fall back to editing
  // the store, so it has to say the bridge is down rather than report a success nobody made.
  const { config } = await bridge({ noBridge: true });
  for (const args of [["devices"], ["revoke", "dv_a"], ["pair"]]) {
    const r = await ctl(config, args);
    assert.notEqual(r.code, 0, `${args[0]} must fail`);
    assert.match(r.stderr, /not running|control socket/i, `${args[0]} must say why`);
  }
});
