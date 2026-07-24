import { spawn, type ChildProcess } from "node:child_process";

/**
 * A PTY-backed interactive shell on the bridge host, streamed over the WebSocket.
 *
 * ⚠️ This is a full shell running as the bridge's process user — arbitrary code execution with that
 * account's privileges. It is gated by `config.terminal.enabled` and audited at open; see docs/SECURITY.md.
 *
 * We reuse the same no-native-module PTY trick the login relay uses (see claude/loginManager.ts):
 * util-linux `script -qefc "<cmd>" /dev/null` gives the child a real controlling TTY, so an interactive
 * shell and TTY-aware tools behave. Keeping it pure-JS (no `node-pty` .node addon) is what lets the .deb
 * stay ~4MB and `Architecture: all`.
 *
 * Known limitation: `script` owns the PTY master, so we can't `TIOCSWINSZ` it after spawn — the size is
 * fixed at launch via the COLUMNS/LINES env (which line-oriented tools honour). Live resize does not
 * reflow a running full-screen TUI. A future `node-pty` optional-dep build could add true resize.
 */
export interface PtyTerminal {
  write(data: string): void;
  /** Best-effort: records the new size but cannot re-signal the running PTY (see class note). */
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface SpawnTerminalOptions {
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  onData: (chunk: string) => void;
  onExit: (code: number | null) => void;
}

/** Spawn an interactive login shell in `cwd` and wire its PTY I/O to the callbacks. */
export function spawnTerminal(opts: SpawnTerminalOptions): PtyTerminal {
  // `-i` for an interactive shell (job control, prompt, rc files). The shell is passed as a single
  // command string to `script -c`; no user input is interpolated here, so there is no shell-injection
  // surface at spawn (the shell path comes from config / $SHELL).
  const child: ChildProcess = spawn(
    "script",
    ["-qefc", `${opts.shell} -i`, "/dev/null"],
    {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group, so kill(-pid) reaps the shell + its children
      env: {
        ...process.env,
        TERM: process.env["TERM"] ?? "xterm-256color",
        COLUMNS: String(Math.max(1, opts.cols | 0) || 80),
        LINES: String(Math.max(1, opts.rows | 0) || 24),
      },
    },
  );

  child.stdout?.on("data", (c: Buffer | string) => opts.onData(typeof c === "string" ? c : c.toString("utf-8")));
  // `script` funnels the child's stderr through the PTY onto stdout; this covers the rare direct write.
  child.stderr?.on("data", (c: Buffer | string) => opts.onData(typeof c === "string" ? c : c.toString("utf-8")));

  let exited = false;
  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    opts.onExit(code);
  };
  child.on("exit", (code) => finish(code));
  child.on("error", () => finish(null)); // e.g. ENOENT for `script`

  const kill = () => {
    if (exited) return;
    try {
      // SIGKILL the whole group: util-linux `script` traps SIGTERM and lingers (same reason as the
      // login relay), and we want the shell + any children gone.
      if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  };

  return {
    write: (data) => {
      try {
        child.stdin?.write(data);
      } catch {
        /* stdin closed — the exit handler will clean up */
      }
    },
    resize: (_cols, _rows) => {
      /* no-op: `script` owns the PTY master; size is fixed at spawn (see class note) */
    },
    kill,
  };
}
