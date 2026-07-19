import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthManager } from "../src/auth/pairing.js";

const created: string[] = [];
async function tokensFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gv-auth-"));
  created.push(dir);
  return join(dir, "tokens.json");
}
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {}))));

// Note: these assert functional correctness of the token/pairing flow — the constant-time property of
// `verify` is a comparison detail (timingSafeEqual) not observable from a unit test.

test("pair issues a token; verify accepts it and rejects everything else", async () => {
  const am = new AuthManager(await tokensFile());
  assert.equal(am.verify("not-a-token"), false);
  assert.equal(am.verify(undefined), false);
  assert.equal(am.verify(""), false);

  const token = await am.pair(am.currentPairingCode);
  assert.ok(token.length >= 32, "token should be reasonably long");
  assert.equal(am.verify(token), true);
  assert.equal(am.verify(token + "x"), false); // different length
  // same length, guaranteed-different last char (avoid accidentally reconstructing the real token)
  const flipped = token.slice(0, -1) + (token.at(-1) === "A" ? "B" : "A");
  assert.equal(am.verify(flipped), false);
});

test("a wrong pairing code is rejected", async () => {
  const am = new AuthManager(await tokensFile());
  await assert.rejects(() => am.pair("WRONG-0000-00"), /invalid pairing|unauthorized/i);
});

test("the pairing code rotates after a successful pair (no replay)", async () => {
  const am = new AuthManager(await tokensFile());
  const code = am.currentPairingCode;
  await am.pair(code);
  await assert.rejects(() => am.pair(code), /invalid pairing|unauthorized/i);
  assert.notEqual(am.currentPairingCode, code);
});

test("an expired pairing code is rejected", async () => {
  const am = new AuthManager(await tokensFile(), -1000); // ttl in the past → already expired, no wait
  await assert.rejects(() => am.pair(am.currentPairingCode), /expired|unauthorized/i);
});

test("issued tokens persist to disk (0600) and reload in a new instance", async () => {
  const file = await tokensFile();
  const am1 = new AuthManager(file);
  const token = await am1.pair(am1.currentPairingCode);

  const st = await stat(file);
  assert.equal(st.mode & 0o777, 0o600, "tokens file must be owner-only");

  const am2 = new AuthManager(file);
  await am2.load();
  assert.equal(am2.verify(token), true);
});
