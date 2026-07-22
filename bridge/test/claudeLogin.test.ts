import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClaudeLoginManager,
  NoPtyError,
  NoUrlError,
  type LoginChild,
} from "../src/claude/loginManager.js";
import type { ClaudeSettingsStore } from "../src/claude/settingsStore.js";

// A canned OSC-8 hyperlink line exactly as `claude setup-token` emits the OAuth authorize URL.
const OAUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=1&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
const URL_LINE = `\x1b]8;id=99;${OAUTH_URL}\x1b\\`;
// A plausible setup-token secret; matches /sk-ant-[A-Za-z0-9._-]{20,}/.
const FAKE_TOKEN = "sk-ant-oat01-AbCdEf0123456789xyzQ_-.KLMNOP";

// ---- a fake settings store recording only the mutations the manager makes -----
function fakeSettings() {
  const calls: Array<{ fn: "setAuth" | "clearAuth"; mode?: string; secret?: string }> = [];
  const store = {
    async setAuth(mode: "api-key" | "subscription", secret: string) {
      calls.push({ fn: "setAuth", mode, secret });
    },
    async clearAuth() {
      calls.push({ fn: "clearAuth" });
    },
  } as unknown as ClaudeSettingsStore;
  return { store, calls };
}

// ---- a fake PTY child the manager can drive without a real `claude`/`script` ---
interface Fake {
  child: LoginChild;
  emitData(s: string): void;
  emitExit(code: number | null): void;
  emitError(): void;
  written: string[];
  killed(): boolean;
}
function fakeChild(): Fake {
  const dataCbs: Array<(c: Buffer | string) => void> = [];
  const exitCbs: Array<(c: number | null) => void> = [];
  const errCbs: Array<(e: NodeJS.ErrnoException) => void> = [];
  const written: string[] = [];
  let _killed = false;
  const child: LoginChild = {
    stdout: { on: (_e, cb) => void dataCbs.push(cb) },
    stdin: { write: (d) => void written.push(d) },
    on: (e, cb) => {
      if (e === "exit") exitCbs.push(cb as (c: number | null) => void);
      else errCbs.push(cb as (err: NodeJS.ErrnoException) => void);
    },
    kill: () => {
      _killed = true;
    },
  };
  return {
    child,
    emitData: (s) => dataCbs.forEach((cb) => cb(s)),
    emitExit: (c) => exitCbs.forEach((cb) => cb(c)),
    emitError: () => errCbs.forEach((cb) => cb(new Error("spawn ENOENT") as NodeJS.ErrnoException)),
    written,
    killed: () => _killed,
  };
}

test("start() scrapes the OAuth URL from the OSC-8 hyperlink and awaits the code", async () => {
  const { store } = fakeSettings();
  const f = fakeChild();
  let launches = 0;
  const mgr = new ClaudeLoginManager(store, () => {
    launches++;
    // Provide the URL right after the manager has wired up its stdout handler.
    queueMicrotask(() => f.emitData(URL_LINE));
    return f.child;
  });

  const { loginId, url } = await mgr.start();
  assert.equal(url, OAUTH_URL, "the FIRST OSC-8 URL is scraped verbatim");
  assert.ok(loginId.startsWith("login-"));
  assert.equal(launches, 1);
});

test("URL split across a PTY read boundary is scraped in full (not truncated at the cut)", async () => {
  const { store } = fakeSettings();
  const f = fakeChild();
  const cut = 50; // lands mid-URL, before the ESC terminator
  const part1 = URL_LINE.slice(0, cut); // OSC-8 opener + a URL prefix, NO terminator yet
  const part2 = URL_LINE.slice(cut); // the rest + \x1b\\ terminator
  const mgr = new ClaudeLoginManager(store, () => {
    queueMicrotask(() => {
      f.emitData(part1); // must NOT lock in the truncated prefix (no complete OSC-8 yet)
      queueMicrotask(() => f.emitData(part2));
    });
    return f.child;
  });

  const { url } = await mgr.start();
  assert.equal(url, OAUTH_URL, "the complete URL is scraped once terminated, not the pre-boundary prefix");
});

test("single-flight: a second start() reuses the in-flight session, spawns nothing", async () => {
  const { store } = fakeSettings();
  const f = fakeChild();
  let launches = 0;
  const mgr = new ClaudeLoginManager(store, () => {
    launches++;
    queueMicrotask(() => f.emitData(URL_LINE));
    return f.child;
  });

  const a = await mgr.start();
  const b = await mgr.start();
  assert.equal(launches, 1, "no second `claude` spawned while a login is in flight");
  assert.deepEqual(a, b, "same loginId + url handed back");
});

test("submit() with a token in the buffer → ok + setAuth(subscription, token)", async () => {
  const { store, calls } = fakeSettings();
  const f = fakeChild();
  const mgr = new ClaudeLoginManager(store, () => {
    queueMicrotask(() => f.emitData(URL_LINE));
    return f.child;
  });

  const { loginId } = await mgr.start();
  // When the code is fed, the PTY prints the token then exits 0.
  const done = mgr.submit(loginId, "AB12-CODE");
  queueMicrotask(() => {
    f.emitData(`\nSuccess! Token: ${FAKE_TOKEN}\n`);
    f.emitExit(0);
  });
  const res = await done;

  assert.deepEqual(res, { status: "ok" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { fn: "setAuth", mode: "subscription", secret: FAKE_TOKEN });
  // The pasted code is forwarded to the PTY exactly once, trimmed + newline-terminated.
  assert.deepEqual(f.written, ["AB12-CODE\n"]);
  // The code must NEVER surface in the returned result.
  assert.ok(!JSON.stringify(res).includes("AB12-CODE"), "code never leaks into the response");
});

test("submit() clean exit but NO token in buffer → ok + clearAuth (host mode)", async () => {
  const { store, calls } = fakeSettings();
  const f = fakeChild();
  const mgr = new ClaudeLoginManager(store, () => {
    queueMicrotask(() => f.emitData(URL_LINE));
    return f.child;
  });

  const { loginId } = await mgr.start();
  const done = mgr.submit(loginId, "code-xyz");
  queueMicrotask(() => {
    f.emitData("\nLogin successful. Credentials written to ~/.claude.\n");
    f.emitExit(0);
  });
  const res = await done;

  assert.deepEqual(res, { status: "ok" });
  assert.deepEqual(calls, [{ fn: "clearAuth" }], "no token → fall back to host ~/.claude");
});

test("submit() non-zero exit → error, NO credential stored, child killed", async () => {
  const { store, calls } = fakeSettings();
  const f = fakeChild();
  const mgr = new ClaudeLoginManager(store, () => {
    queueMicrotask(() => f.emitData(URL_LINE));
    return f.child;
  });

  const { loginId } = await mgr.start();
  const done = mgr.submit(loginId, "wrong-code");
  // Even if a token-looking string is in the buffer, a non-zero exit must store NOTHING.
  queueMicrotask(() => {
    f.emitData(`error: invalid code (${FAKE_TOKEN})\n`);
    f.emitExit(1);
  });
  const res = await done;

  assert.equal(res.status, "error");
  assert.equal(calls.length, 0, "a failed login stores no credential");
  assert.ok(!JSON.stringify(res).includes(FAKE_TOKEN), "no token in the error response");
  assert.ok(!JSON.stringify(res).includes("wrong-code"), "no code in the error response");
});

test("submit() with an unknown / expired loginId → error, spawns/stores nothing", async () => {
  const { store, calls } = fakeSettings();
  const f = fakeChild();
  const mgr = new ClaudeLoginManager(store, () => {
    queueMicrotask(() => f.emitData(URL_LINE));
    return f.child;
  });

  await mgr.start();
  const res = await mgr.submit("login-bogus", "any-code");
  assert.equal(res.status, "error");
  assert.match(res.message ?? "", /start again/);
  assert.equal(calls.length, 0);
  assert.deepEqual(f.written, [], "no code forwarded for an unknown login id");
});

test("a missing `script` PTY (spawn error) surfaces as NoPtyError", async () => {
  const { store } = fakeSettings();
  const f = fakeChild();
  const mgr = new ClaudeLoginManager(store, () => {
    // Simulate ENOENT: the child emits 'error' asynchronously instead of any stdout.
    queueMicrotask(() => f.emitError());
    return f.child;
  });

  await assert.rejects(mgr.start(), (err) => err instanceof NoPtyError);
});

test("the child exiting before any URL is scraped surfaces as NoUrlError", async () => {
  const { store } = fakeSettings();
  const f = fakeChild();
  const mgr = new ClaudeLoginManager(store, () => {
    queueMicrotask(() => f.emitExit(0)); // dies before emitting the OSC-8 URL
    return f.child;
  });

  await assert.rejects(mgr.start(), (err) => err instanceof NoUrlError);
});

test("cancel() kills the active child and lets a fresh login start", async () => {
  const { store } = fakeSettings();
  const f1 = fakeChild();
  const f2 = fakeChild();
  let n = 0;
  const mgr = new ClaudeLoginManager(store, () => {
    const f = n++ === 0 ? f1 : f2;
    queueMicrotask(() => f.emitData(URL_LINE));
    return f.child;
  });

  const first = await mgr.start();
  mgr.cancel(first.loginId);
  assert.ok(f1.killed(), "cancel kills the in-flight PTY child");

  const second = await mgr.start();
  assert.equal(n, 2, "a fresh login after cancel spawns a new child");
  assert.notEqual(second.loginId, first.loginId);
});
