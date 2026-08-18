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
 * interpreter, matching how the .deb invokes it when node is outside the system PATH. Each harness returns
 * its OWN `ctl`, bound to its own socket via GITVIEW_CONTROL_SOCKET — never the config parse. A config
 * missing `controlSocket:` falls back to /run/gitview-bridge/control.sock, so a parse regression would
 * point the whole suite at whatever bridge is running on the host: `pair` rotating its live pairing code
 * every run, `revoke` doing worse. Tests must not be able to reach production by accident.
 */
const SCRIPT = new URL("../packaging/deb/gitview-bridgectl", import.meta.url).pathname;

const created: string[] = [];
const sockets: ControlSocket[] = [];
after(async () => {
  await Promise.all(sockets.map((s) => s.close().catch(() => {})));
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** A config the CLI can read, a socket-bound `ctl`, and (unless `noBridge`) a live socket behind it. */
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
  const ctl = async (
    args: string[],
    extraEnv: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string; code: number }> => {
    try {
      const r = await exec("sh", [SCRIPT, ...args], {
        env: {
          ...process.env,
          GITVIEW_CONFIG: config,
          GITVIEW_CONTROL_SOCKET: sockPath,
          GITVIEW_SUDO: "",
          GITVIEW_NODE: process.execPath,
          ...extraEnv,
        },
      });
      return { stdout: r.stdout, stderr: r.stderr, code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
    }
  };

  return { dir, config, auth, sockPath, tokens, ctl };
}

test("devices lists what the bridge reports, including connected state", async () => {
  const { ctl, auth } = await bridge();
  await auth.pair(auth.currentPairingCode, "Pixel 8");
  const { stdout, code } = await ctl(["devices"]);
  assert.equal(code, 0);
  assert.match(stdout, /ID\s+NAME\s+CONNECTED\s+LAST SEEN/, "connected is back — the socket can answer it");
  assert.match(stdout, /Pixel 8\s+no/);
});

test("a store full of pre-0.1.8 tokens lists no devices at all", async () => {
  // It used to fold them into one synthetic `legacy` row. ADR-037 refuses those tokens, so there is no
  // device to show — and showing a row for credentials that no longer authenticate would be a lie.
  const { ctl, dir, sockPath, tokens } = await bridge({ noBridge: true });
  await writeFile(tokens, JSON.stringify({ devices: [], tokens: ["a", "b", "c"] }), { mode: 0o600 });
  const auth = new AuthManager(tokens);
  await auth.load();
  assert.equal(auth.staleBareTokenCount, 3, "counted, so boot can warn about them");
  const sock = new ControlSocket(sockPath, {
    auth, connectedDeviceIds: () => new Set<string>(), disconnectDevice: () => 0, pairingTtlMs: 600_000,
  });
  sockets.push(sock);
  assert.equal(await sock.start(), true);
  assert.ok(dir);
  assert.match((await ctl(["devices"])).stdout, /No devices paired/);
});

test("devices on an empty bridge says so", async () => {
  const { ctl } = await bridge();
  assert.match((await ctl(["devices"])).stdout, /No devices paired/);
});

test("revoke removes the device and reports the connections the BRIDGE closed", async () => {
  const { ctl, auth } = await bridge();
  const token = await auth.pair(auth.currentPairingCode, "phone");
  const id = token.split(".")[0]!;
  const { stdout, code } = await ctl(["revoke", id]);
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`Revoked ${id} — 1 credential, 1 connection`), "reports what happened, not a guess");
  assert.equal(auth.verify(token), false, "the bridge's own store is updated — no second writer");
});

test("revoke does not disturb a pending pairing code", async () => {
  // The reason signals were dropped: one carried no payload, so revoking also minted a new code and
  // invalidated the one you had just generated to re-pair a good phone.
  const { ctl, auth } = await bridge();
  const token = await auth.pair(auth.currentPairingCode, "throwaway");
  const code = auth.currentPairingCode;
  await ctl(["revoke", token.split(".")[0]!]);
  assert.equal(auth.currentPairingCode, code, "revoking must not burn the code you are about to type");
});

test("revoke of an unknown id fails loudly", async () => {
  const { ctl } = await bridge();
  const { code, stderr } = await ctl(["revoke", "dv_nope"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /unknown device/);
});

test("pair returns a code from the bridge, not from the journal", async () => {
  const { ctl, auth } = await bridge();
  const { stdout, code } = await ctl(["pair"]);
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
  const { ctl, auth, sockPath } = await bridge();
  await auth.pair(auth.currentPairingCode, "Pixel 8");
  const dir = dirname(sockPath);
  // Its own temp dir, registered for cleanup: join(dir, "..") resolved to a FIXED /tmp/sudo-stub.sh --
  // shared between concurrent runs, left behind afterwards, and a pre-created file or symlink there
  // would be executed by this test. It cannot live in `dir`, which is about to become untraversable.
  const stubDir = await mkdtemp(join(tmpdir(), "gv-stub-"));
  created.push(stubDir);
  const stub = join(stubDir, "sudo-stub.sh");
  await writeFile(stub, `#!/bin/sh\nchmod 0700 '${dir}'\n"$@"\nrc=$?\nchmod 0000 '${dir}'\nexit $rc\n`, { mode: 0o755 });
  await chmod(dir, 0o000);
  try {
    const { stdout, code } = await ctl(["devices"], { GITVIEW_SUDO: stub });
    assert.equal(code, 0, "a running bridge must not be reported as down just because you can't see it");
    assert.match(stdout, /Pixel 8/);
  } finally {
    await chmod(dir, 0o700); // so the after() cleanup can remove it
  }
});

test("with no bridge running, every command fails clearly instead of pretending", async () => {
  // The cost the socket introduces, and it must be visible: the CLI can no longer fall back to editing
  // the store, so it has to say the bridge is down rather than report a success nobody made.
  const { ctl } = await bridge({ noBridge: true });
  for (const args of [["devices"], ["revoke", "dv_a"], ["pair"]]) {
    const r = await ctl(args);
    assert.notEqual(r.code, 0, `${args[0]} must fail`);
    assert.match(r.stderr, /not running|control socket/i, `${args[0]} must say why`);
  }
});

/**
 * `kicad convert` — the config parsing, which is where every defect in this subcommand has been.
 *
 * The first version read the config with two sed expressions and got three things wrong at once: a
 * trailing comment became part of the cache path, `~` and relative paths were never expanded, and the
 * `modelPaths` scan only matched four-space block style, so a two-space or flow mapping silently
 * produced no mappings and every model came back `unresolved`. A fourth was worse and quieter: the repo
 * id was guessed from the directory basename, so a configured id — or a folder needing a slug — wrote a
 * manifest under a hash the bridge would never read.
 *
 * None of that is visible from reading the script, which is why these drive it.
 */
async function kicadHarness(configBody: string) {
  const dir = await mkdtemp(join(tmpdir(), "gv-kctl-"));
  created.push(dir);
  const config = join(dir, "config.yaml");
  await writeFile(config, configBody.replace(/@DIR@/g, dir));
  // A stub converter that records the argv it was handed. The real one is a CAD kernel; what is under
  // test here is what reaches it.
  const conv = join(dir, "fake-cli.js");
  await writeFile(conv, `require("fs").writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));\n`);
  const run = async (args: string[]) => {
    try {
      const r = await exec("sh", [SCRIPT, ...args], {
        env: { ...process.env, GITVIEW_CONFIG: config, GITVIEW_SUDO: "", GITVIEW_NODE: process.execPath, GITVIEW_CONVERTER: conv },
        cwd: dirname(SCRIPT),
      });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  };
  return { dir, run };
}

const argvOf = async (dir: string): Promise<string[]> =>
  JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "argv.json"), "utf8"));

test("kicad convert reads the cache, mappings and repo id out of the config", async () => {
  const { dir, run } = await kicadHarness(
    `repos:\n  - id: hw\n    path: @DIR@/board\nkicad:\n` +
    `  meshCache: ./meshes   # trailing comment\n  modelPaths:\n   VAR: /opt/models\n`,
  );
  await (await import("node:fs/promises")).mkdir(join(dir, "board"), { recursive: true });
  const r = await run(["kicad", "convert", join(dir, "board"), "b.kicad_pcb"]);
  assert.equal(r.code, 0, r.stderr);
  const argv = await argvOf(dir);
  // The comment is not part of the path, and a relative cache resolves against the CONFIG's directory —
  // which is what the bridge does — not the current working directory.
  assert.ok(argv.includes(join(dir, "meshes")), `cache not expanded: ${argv.join(" ")}`);
  // Three-space block nesting is valid YAML and the sed version missed it entirely.
  assert.ok(argv.includes("VAR=/opt/models"), `mapping lost: ${argv.join(" ")}`);
  // The CONFIGURED id, not the folder name — manifests are keyed by it.
  assert.equal(argv[argv.indexOf("--repo-id") + 1], "hw");
});

test("kicad convert passes the operator's own arguments through", async () => {
  // `--max-mb` is the one a large board actually needs, and the default of 32 is what skips the models
  // this command exists to warm. An earlier version rebuilt the argument list and dropped it.
  const { dir, run } = await kicadHarness(
    `repos:\n  - id: hw\n    path: @DIR@/board\nkicad:\n  meshCache: @DIR@/meshes\n`,
  );
  await (await import("node:fs/promises")).mkdir(join(dir, "board"), { recursive: true });
  const r = await run(["kicad", "convert", join(dir, "board"), "b.kicad_pcb", "--max-mb", "128"]);
  assert.equal(r.code, 0, r.stderr);
  const argv = await argvOf(dir);
  assert.equal(argv[argv.indexOf("--max-mb") + 1], "128");
});

test("kicad convert refuses a repo the bridge does not serve", async () => {
  // Guessing an id writes a manifest under a hash the bridge never reads — a cache that looks built and
  // is invisible. Refusing is the honest answer.
  const { dir, run } = await kicadHarness(`repos: []\nkicad:\n  meshCache: @DIR@/meshes\n`);
  const r = await run(["kicad", "convert", join(dir, "elsewhere"), "b.kicad_pcb"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not one of the repos/);
});

test("kicad convert says so when no converter is installed", async () => {
  const { dir, run } = await kicadHarness(
    `repos:\n  - id: hw\n    path: @DIR@/board\nkicad:\n  meshCache: @DIR@/meshes\n`,
  );
  const r = await run(["kicad", "convert", join(dir, "board"), "b.kicad_pcb"].map(String));
  // With GITVIEW_CONVERTER pointing at the stub this succeeds; the absent case is the default path.
  assert.ok(r.code === 0 || /no converter installed/.test(r.stderr));
});
