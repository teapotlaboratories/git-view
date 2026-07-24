import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeSettingsStore, isEffortLevel } from "../src/claude/settingsStore.js";

async function store(defaultEffort?: "low" | "medium" | "high" | "xhigh" | "max") {
  const dir = await mkdtemp(join(tmpdir(), "gitview-effort-"));
  const file = join(dir, "claude-settings.json");
  const s = new ClaudeSettingsStore(file, "claude-opus-4-8", defaultEffort);
  await s.load();
  return { s, file };
}

test("unset effort stays undefined so no `effort` is passed to the SDK", async () => {
  const { s } = await store();
  assert.equal(s.effort, undefined);
});

test("config default applies until an override is set, and the override wins", async () => {
  const { s } = await store("medium");
  assert.equal(s.effort, "medium");
  await s.setEffort("xhigh");
  assert.equal(s.effort, "xhigh");
});

test("empty/null clears the override back to the config default", async () => {
  const { s } = await store("medium");
  await s.setEffort("max");
  assert.equal(s.effort, "max");
  await s.setEffort("");
  assert.equal(s.effort, "medium", "blank must reset, not pin an empty level");
  await s.setEffort("high");
  await s.setEffort(null);
  assert.equal(s.effort, "medium");
});

test("clearing with no config default returns to undefined (SDK default), not a pinned level", async () => {
  const { s } = await store();
  await s.setEffort("low");
  await s.setEffort("");
  assert.equal(s.effort, undefined);
});

test("an unknown level is rejected and does NOT mutate stored state", async () => {
  const { s } = await store();
  await s.setEffort("high");
  await assert.rejects(() => s.setEffort("turbo"), /unknown effort level/);
  assert.equal(s.effort, "high", "a rejected write must leave the previous value intact");
});

test("all five SDK levels round-trip through persistence", async () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
    const { s, file } = await store();
    await s.setEffort(level);
    const reloaded = new ClaudeSettingsStore(file, "claude-opus-4-8");
    await reloaded.load();
    assert.equal(reloaded.effort, level, `${level} must survive a reload`);
  }
});

test("effort persists alongside model + auth without clobbering them", async () => {
  const { s, file } = await store();
  await s.setModel("claude-sonnet-5");
  await s.setEffort("low");
  await s.setAuth("api-key", "sk-secret-value");
  const reloaded = new ClaudeSettingsStore(file, "claude-opus-4-8");
  await reloaded.load();
  assert.equal(reloaded.model, "claude-sonnet-5");
  assert.equal(reloaded.effort, "low");
  assert.equal(reloaded.authMode, "api-key");
});

test("a hand-edited file with a bogus effort is ignored on load, not propagated to the SDK", async () => {
  const { file } = await store();
  await writeFile(file, JSON.stringify({ model: "claude-opus-4-8", effort: "ludicrous" }), "utf-8");
  const s = new ClaudeSettingsStore(file, "claude-opus-4-8");
  await s.load();
  assert.equal(s.effort, undefined, "an invalid stored level must not reach options.effort");
  assert.equal(s.model, "claude-opus-4-8", "the rest of the file still loads");
});

test("the settings file stays 0600 after an effort write", async () => {
  const { s, file } = await store();
  await s.setEffort("high");
  const { mode } = await (await import("node:fs/promises")).stat(file);
  assert.equal(mode & 0o777, 0o600);
  // sanity: the secret-free file is plain JSON
  JSON.parse(await readFile(file, "utf-8"));
});

test("isEffortLevel narrows only the five known levels", () => {
  for (const ok of ["low", "medium", "high", "xhigh", "max"]) assert.ok(isEffortLevel(ok));
  for (const bad of ["", "LOW", "higher", "1", null, undefined, 3, {}]) assert.ok(!isEffortLevel(bad));
});
