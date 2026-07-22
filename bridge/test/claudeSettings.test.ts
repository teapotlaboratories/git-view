import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSettingsStore } from "../src/claude/settingsStore.js";

const created: string[] = [];
async function settingsFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gv-claude-"));
  created.push(dir);
  return join(dir, "claude-settings.json");
}
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {}))));

const DEFAULT_MODEL = "claude-opus-4-8";

test("fresh store: model is the config default, auth is host, hint null, credentialEnv null", async () => {
  const s = new ClaudeSettingsStore(await settingsFile(), DEFAULT_MODEL);
  await s.load(); // no file yet
  assert.equal(s.model, DEFAULT_MODEL);
  assert.equal(s.authMode, "host");
  assert.equal(s.hint, null);
  assert.equal(s.credentialEnv(), null);
});

test("setAuth persists and reloads round-trip (0600 on disk)", async () => {
  const file = await settingsFile();
  const s1 = new ClaudeSettingsStore(file, DEFAULT_MODEL);
  await s1.setAuth("api-key", "sk-secret-abcd");

  const st = await stat(file);
  assert.equal(st.mode & 0o777, 0o600, "settings file must be owner-only");

  const s2 = new ClaudeSettingsStore(file, DEFAULT_MODEL);
  await s2.load();
  assert.equal(s2.authMode, "api-key");
  assert.equal(s2.hint, "…abcd");
});

test("hint masks to the last 4 chars and never equals the secret", async () => {
  const s = new ClaudeSettingsStore(await settingsFile(), DEFAULT_MODEL);
  const secret = "sk-super-secret-value-9x7z";
  await s.setAuth("subscription", secret);
  assert.equal(s.hint, "…" + secret.slice(-4));
  assert.notEqual(s.hint, secret);
  assert.ok(!s.hint!.includes(secret), "hint must not leak the full secret");
});

test("credentialEnv (api-key): sets ANTHROPIC_API_KEY, deletes ANTHROPIC_AUTH_TOKEN, keeps PATH", async () => {
  const prev = { key: process.env["ANTHROPIC_API_KEY"], tok: process.env["ANTHROPIC_AUTH_TOKEN"] };
  process.env["ANTHROPIC_AUTH_TOKEN"] = "leftover-token"; // must be scrubbed
  delete process.env["ANTHROPIC_API_KEY"];
  try {
    const s = new ClaudeSettingsStore(await settingsFile(), DEFAULT_MODEL);
    await s.setAuth("api-key", "sk-the-key");
    const env = s.credentialEnv();
    assert.ok(env, "credentialEnv should be non-null when a credential is stored");
    assert.equal(env!["ANTHROPIC_API_KEY"], "sk-the-key");
    assert.equal("ANTHROPIC_AUTH_TOKEN" in env!, false, "the OTHER var must be deleted");
    assert.equal(env!["PATH"], process.env["PATH"], "PATH (and other env) survive");
  } finally {
    if (prev.key === undefined) delete process.env["ANTHROPIC_API_KEY"]; else process.env["ANTHROPIC_API_KEY"] = prev.key;
    if (prev.tok === undefined) delete process.env["ANTHROPIC_AUTH_TOKEN"]; else process.env["ANTHROPIC_AUTH_TOKEN"] = prev.tok;
  }
});

test("credentialEnv (subscription): sets ANTHROPIC_AUTH_TOKEN, deletes ANTHROPIC_API_KEY", async () => {
  const prev = { key: process.env["ANTHROPIC_API_KEY"], tok: process.env["ANTHROPIC_AUTH_TOKEN"] };
  process.env["ANTHROPIC_API_KEY"] = "leftover-key"; // must be scrubbed
  delete process.env["ANTHROPIC_AUTH_TOKEN"];
  try {
    const s = new ClaudeSettingsStore(await settingsFile(), DEFAULT_MODEL);
    await s.setAuth("subscription", "sub-token");
    const env = s.credentialEnv();
    assert.ok(env);
    assert.equal(env!["ANTHROPIC_AUTH_TOKEN"], "sub-token");
    assert.equal("ANTHROPIC_API_KEY" in env!, false, "the OTHER var must be deleted");
  } finally {
    if (prev.key === undefined) delete process.env["ANTHROPIC_API_KEY"]; else process.env["ANTHROPIC_API_KEY"] = prev.key;
    if (prev.tok === undefined) delete process.env["ANTHROPIC_AUTH_TOKEN"]; else process.env["ANTHROPIC_AUTH_TOKEN"] = prev.tok;
  }
});

test("clearAuth reverts to host: hint null, credentialEnv null, persists", async () => {
  const file = await settingsFile();
  const s = new ClaudeSettingsStore(file, DEFAULT_MODEL);
  await s.setAuth("api-key", "sk-x");
  assert.equal(s.authMode, "api-key");
  await s.clearAuth();
  assert.equal(s.authMode, "host");
  assert.equal(s.hint, null);
  assert.equal(s.credentialEnv(), null);

  const reloaded = new ClaudeSettingsStore(file, DEFAULT_MODEL);
  await reloaded.load();
  assert.equal(reloaded.authMode, "host", "cleared auth stays cleared after reload");
});

test("setModel overrides, then reset (empty/null) reverts to the config default", async () => {
  const file = await settingsFile();
  const s = new ClaudeSettingsStore(file, DEFAULT_MODEL);
  await s.setModel("claude-sonnet-4-5");
  assert.equal(s.model, "claude-sonnet-4-5");

  const reloaded = new ClaudeSettingsStore(file, DEFAULT_MODEL);
  await reloaded.load();
  assert.equal(reloaded.model, "claude-sonnet-4-5", "model override round-trips");

  await reloaded.setModel("");
  assert.equal(reloaded.model, DEFAULT_MODEL, "empty resets to the config default");
  await reloaded.setModel("x");
  await reloaded.setModel(null);
  assert.equal(reloaded.model, DEFAULT_MODEL, "null also resets to the config default");
});

test("corrupt settings file tolerated → treated as host/default", async () => {
  const file = await settingsFile();
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "{ not valid json", "utf-8");
  const s = new ClaudeSettingsStore(file, DEFAULT_MODEL);
  await s.load();
  assert.equal(s.model, DEFAULT_MODEL);
  assert.equal(s.authMode, "host");
});
