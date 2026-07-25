import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { spawnTerminal } from "../src/terminal/ptyTerminal.js";

/**
 * Exercises the real PTY path (`script -qefc`). These need util-linux `script` + a POSIX shell, which
 * the bridge already depends on for the Claude login relay, so they run on the same hosts the bridge does.
 */

test("runs a command in the shell and streams its output", async () => {
  const out: string[] = [];
  const exit = new Promise<number | null>((resolve) => {
    const term = spawnTerminal({
      cwd: tmpdir(),
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
      onData: (c) => out.push(c),
      onExit: resolve,
    });
    // Print a unique marker, then leave the shell so onExit fires.
    term.write("printf 'MARKER_%s\\n' 4242\n");
    setTimeout(() => term.write("exit\n"), 200);
  });

  const code = await exit;
  assert.equal(code, 0, "shell should exit cleanly on `exit`");
  assert.match(out.join(""), /MARKER_4242/, "command output should be streamed back");
});

test("starts in the requested cwd", async () => {
  const out: string[] = [];
  const exit = new Promise<number | null>((resolve) => {
    const term = spawnTerminal({
      cwd: tmpdir(),
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
      onData: (c) => out.push(c),
      onExit: resolve,
    });
    term.write("pwd\n");
    setTimeout(() => term.write("exit\n"), 200);
  });

  await exit;
  // tmpdir() may be a symlink (e.g. /tmp -> /private/tmp); just assert a plausible absolute path echoed.
  assert.match(out.join(""), /\/tmp|\/var\/folders/, "pwd should reflect an absolute cwd");
});

test("kill() terminates a long-running shell and fires onExit", async () => {
  const exit = new Promise<number | null>((resolve) => {
    const term = spawnTerminal({
      cwd: tmpdir(),
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: resolve,
    });
    term.write("sleep 30\n");
    setTimeout(() => term.kill(), 150);
  });

  // SIGKILL of the group — onExit must fire (code is null/non-zero, we only require that it resolves).
  await exit;
  assert.ok(true, "onExit resolved after kill()");
});
