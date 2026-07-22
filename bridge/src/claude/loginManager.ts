import { spawn } from "node:child_process";
import type { ClaudeSettingsStore } from "./settingsStore.js";

/**
 * Subscription-login relay: drives `claude setup-token` inside a pseudo-terminal, scrapes the OAuth
 * authorize URL for the app to open, then feeds back the pasted code. On success the resulting host
 * auth state is reflected through the ClaudeSettingsStore.
 *
 * SECRECY: the pasted code and any captured token NEVER enter a log line, an audit target, or a wire
 * response. Only the OAuth URL (which is not itself a secret) and a coarse status ever leave here.
 *
 * SINGLE-FLIGHT: at most one PTY child is alive at a time. A second start() while a login is in
 * flight (and fresh) returns the same { loginId, url } instead of spawning another `claude`.
 *
 * WHY `script`: `claude setup-token` is TTY-interactive — without a PTY it prints nothing. util-linux
 * `script -qefc "claude setup-token" /dev/null` gives it a PTY; we read the PTY via child.stdout and
 * write the code via child.stdin. No native module required.
 */

// Minimal child shape we depend on — lets tests inject a fake launcher (no real `claude`/PTY).
export interface LoginChild {
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): void };
  stdin: { write(data: string): void };
  on(event: "exit", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: NodeJS.ErrnoException) => void): void;
  kill(): void;
}

export type LoginLauncher = () => LoginChild;

/** Tagged error the route maps to 500 { error: "no_pty" } (the `script` tool is missing). */
export class NoPtyError extends Error {
  constructor() {
    super("no_pty");
    this.name = "NoPtyError";
  }
}
/** Tagged error the route maps to 500 { error: "no_url" } (no OAuth URL scraped in time). */
export class NoUrlError extends Error {
  constructor() {
    super("no_url");
    this.name = "NoUrlError";
  }
}

// OSC-8 hyperlink: ESC ] 8 ; <params> ; <URL> <ST>. The URL repeats across terminal redraws — take
// the FIRST COMPLETE one. Require the ESC/BEL terminator (lazy capture) so a chunk that splits the
// sequence mid-URL produces NO match (scraping continues as the buffer grows) rather than locking in a
// truncated URL.
const OSC8_URL = /\x1b\]8;[^;]*;(https:\/\/[^\x1b\x07]+?)[\x1b\x07]/;
// A setup-token secret in the PTY output. If present on success we store it; otherwise ~/.claude was
// populated directly (host mode).
const TOKEN_RE = /sk-ant-[A-Za-z0-9._-]{20,}/;

type Status = "starting" | "awaiting-code" | "done" | "error";

interface LoginSession {
  id: string;
  child: LoginChild;
  url: string | null;
  buf: string;
  status: Status;
  createdAt: number;
  timer: NodeJS.Timeout | null; // overall 5-min TTL
  urlTimer: NodeJS.Timeout | null; // 20s deadline to scrape the URL
  // Every concurrent start() awaiting this session's URL registers here; ALL fire once (then cleared).
  urlWaiters: Array<{ resolve: (url: string) => void; reject: (err: Error) => void }>;
}

const URL_TIMEOUT_MS = 20_000; // scrape the OAuth URL within this or fail no_url
const SESSION_TTL_MS = 5 * 60 * 1000; // overall life of one login attempt
const SUBMIT_TIMEOUT_MS = 45_000; // cap the wait for the child to exit after we feed the code

// Module-level monotonic counter — combined with process.hrtime.bigint() inside start() for a unique
// id. Deliberately NO Date.now()/Math.random() at module top-level (keeps the module import pure).
let idCounter = 0;

export class ClaudeLoginManager {
  private session: LoginSession | null = null;

  constructor(
    private readonly settings: ClaudeSettingsStore,
    // Injectable so tests can supply a fake child (the real one PTY-spawns `claude setup-token`).
    private readonly launch: LoginLauncher = defaultLauncher,
  ) {}

  /**
   * Begin (or rejoin) a login. Returns the OAuth URL for the app to open. Single-flight: a fresh,
   * non-terminal session is reused rather than spawning a second `claude`.
   */
  async start(): Promise<{ loginId: string; url: string }> {
    const s = this.session;
    if (
      s &&
      s.status === "awaiting-code" &&
      s.url &&
      Date.now() - s.createdAt < SESSION_TTL_MS
    ) {
      // Already have a URL and are awaiting the code — hand the same one back, spawn nothing.
      return { loginId: s.id, url: s.url };
    }
    if (
      s &&
      s.status === "starting" &&
      Date.now() - s.createdAt < SESSION_TTL_MS
    ) {
      // A start() is mid-scrape; wait for that same session's URL instead of spawning a second child.
      const url = await this.awaitUrl(s);
      return { loginId: s.id, url };
    }
    // Otherwise (no session, or a terminal/stale one) start fresh.
    if (s) this.cleanup();

    const id = `login-${process.hrtime.bigint().toString(36)}-${(idCounter++).toString(36)}`;
    let child: LoginChild;
    try {
      child = this.launch();
    } catch {
      throw new NoPtyError();
    }

    const session: LoginSession = {
      id,
      child,
      url: null,
      buf: "",
      status: "starting",
      createdAt: Date.now(),
      timer: null,
      urlTimer: null,
      urlWaiters: [],
    };
    this.session = session;

    // Overall TTL: kill the child and fail the attempt after 5 min.
    session.timer = setTimeout(() => {
      if (this.session === session && session.status !== "done") {
        session.status = "error";
        this.cleanup(); // rejects any pending url waiters
      }
    }, SESSION_TTL_MS);
    session.timer.unref?.(); // don't keep the event loop alive just for this timer

    // Deadline to scrape the URL — cleared the moment we see it.
    session.urlTimer = setTimeout(() => {
      if (this.session === session && !session.url && session.status === "starting") {
        session.status = "error";
        this.cleanup();
      }
    }, URL_TIMEOUT_MS);
    session.urlTimer.unref?.();

    child.stdout.on("data", (chunk) => {
      // Accumulate into THIS child's own session buffer regardless of whether it is still the active
      // slot — submit() detaches the session but keeps driving the child and reads this.buf afterwards.
      session.buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      if (!session.url) {
        const m = OSC8_URL.exec(session.buf);
        if (m) {
          session.url = m[1]!;
          if (session.status === "starting") session.status = "awaiting-code";
          if (session.urlTimer) {
            clearTimeout(session.urlTimer);
            session.urlTimer = null;
          }
          this.resolveWaiters(session, session.url); // fires ALL concurrent start() waiters
        }
      }
    });

    // ENOENT for `script` (or spawn failure) → no_pty.
    child.on("error", () => {
      if (this.session !== session) return;
      session.status = "error";
      this.failWaiters(session, new NoPtyError());
      this.cleanup();
    });

    // If the child exits before we ever scraped a URL, treat it as no_url.
    child.on("exit", () => {
      if (this.session !== session) return;
      if (session.status === "starting" && !session.url) {
        session.status = "error";
        this.failWaiters(session, new NoUrlError());
        this.cleanup();
      }
    });

    const url = await this.awaitUrl(session);
    return { loginId: id, url };
  }

  /**
   * Feed the pasted code to the PTY and await completion. On a clean exit, store any captured token as
   * subscription auth (else clear to host). NEVER logs/returns the code or token.
   */
  async submit(id: string, code: string): Promise<{ status: "ok" | "error"; message?: string }> {
    const s = this.session;
    if (!s || s.id !== id || s.status !== "awaiting-code") {
      return { status: "error", message: "login expired — start again" };
    }
    // Take ownership and DETACH from the shared slot synchronously (before any await) so a concurrent
    // start() begins a fresh login instead of tearing down the child we're about to drive. From here we
    // own `s` and tear down only our own child; this.session may become a new login while we await.
    s.status = "done";
    this.session = null;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (s.urlTimer) {
      clearTimeout(s.urlTimer);
      s.urlTimer = null;
    }
    const child = s.child;

    const exitCode = await new Promise<number | null>((resolve) => {
      let settled = false;
      const finish = (c: number | null) => {
        if (settled) return;
        settled = true;
        resolve(c);
      };
      const capTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish(-1); // treat a hung child as failure
      }, SUBMIT_TIMEOUT_MS);
      capTimer.unref?.();
      child.on("exit", (c) => {
        clearTimeout(capTimer);
        finish(c);
      });
      try {
        child.stdin.write(code.trim() + "\n");
      } catch {
        clearTimeout(capTimer);
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish(-1);
      }
    });

    // Kill only OUR child (this.session may be a fresh login by now). The stdout handler's closure over
    // `s` kept filling s.buf while we drove the child, so it holds any token printed after the code.
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    const buf = s.buf;

    if (exitCode === 0) {
      const m = TOKEN_RE.exec(buf);
      if (m) {
        await this.settings.setAuth("subscription", m[0]);
      } else {
        // No token in the output → assume ~/.claude was populated directly (host mode).
        await this.settings.clearAuth();
      }
      return { status: "ok" };
    }
    return { status: "error", message: "login failed — check the code and retry" };
  }

  /** Kill the active child (if id matches) and clear the session. */
  cancel(id: string): void {
    const s = this.session;
    if (!s || s.id !== id) return;
    this.cleanup();
  }

  /** Cancel whatever is in flight — used on server shutdown. */
  cancelActive(): void {
    if (this.session) this.cleanup();
  }

  /** Resolve once this session's URL is scraped, or reject (no_url) if it never arrives. */
  private awaitUrl(session: LoginSession): Promise<string> {
    if (session.url) return Promise.resolve(session.url);
    // The session's urlTimer (armed in start) fails all waiters via cleanup() if the URL never arrives,
    // so every registered waiter settles — no HTTP call hangs.
    return new Promise<string>((resolve, reject) => {
      session.urlWaiters.push({ resolve, reject });
    });
  }

  /** Fire every pending url waiter with the scraped URL, then clear the list. */
  private resolveWaiters(session: LoginSession, url: string): void {
    const waiters = session.urlWaiters;
    session.urlWaiters = [];
    for (const w of waiters) w.resolve(url);
  }

  /** Reject every pending url waiter, then clear the list. */
  private failWaiters(session: LoginSession, err: Error): void {
    const waiters = session.urlWaiters;
    session.urlWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  /** Clear timers, reject any pending waiters, kill the child, and drop the active session. Repeatable. */
  private cleanup(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (s.urlTimer) clearTimeout(s.urlTimer);
    s.urlTimer = null;
    this.failWaiters(s, new NoUrlError()); // settle any waiters so their /start HTTP calls don't hang
    try {
      s.child.kill();
    } catch {
      /* already gone */
    }
  }
}

/** The real launcher: wrap `claude setup-token` in a util-linux `script` PTY. */
function defaultLauncher(): LoginChild {
  // `detached: true` makes `script` a new process-group leader, so we can signal the WHOLE group
  // (script AND its `claude setup-token` grandchild). Killing only `script` orphans the grandchild.
  const child = spawn("script", ["-qefc", "claude setup-token", "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const groupKill = () => {
    // SIGKILL, not SIGTERM: util-linux `script` traps SIGTERM (to restore the terminal) and lingers,
    // and these are throwaway login attempts with nothing to flush. Signal the whole group, then the
    // wrapper directly as a backstop.
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
    } catch {
      /* group already gone */
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  // Shadow kill() so LoginChild.kill() (called by the manager) tears down the entire group.
  (child as unknown as { kill: () => void }).kill = groupKill;
  return child as unknown as LoginChild;
}
