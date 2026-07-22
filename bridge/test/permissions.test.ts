import { test } from "node:test";
import assert from "node:assert/strict";
import { isInteractive, permissionDecision } from "../src/claude/permissions.js";

test("only the interactive tiers run the gate", () => {
  assert.equal(isInteractive("confined-agent"), true);
  assert.equal(isInteractive("acceptEdits"), true);
  assert.equal(isInteractive("auto"), true);
  assert.equal(isInteractive("read-only"), false);
  assert.equal(isInteractive("dontAsk"), false);
  assert.equal(isInteractive("bypassPermissions"), false);
});

test("reads never prompt on any interactive tier", () => {
  for (const p of ["confined-agent", "acceptEdits", "auto"] as const) {
    assert.equal(permissionDecision(p, "Read", { file_path: "a.ts" }), "allow");
    assert.equal(permissionDecision(p, "Grep", { pattern: "x" }), "allow");
  }
});

test("Ask first prompts on every edit & command", () => {
  assert.equal(permissionDecision("confined-agent", "Edit", { file_path: "a.ts" }), "prompt");
  assert.equal(permissionDecision("confined-agent", "Write", { file_path: "a.ts" }), "prompt");
  assert.equal(permissionDecision("confined-agent", "Bash", { command: "ls" }), "prompt");
});

test("Auto-edit auto-allows edits but prompts commands", () => {
  assert.equal(permissionDecision("acceptEdits", "Edit", { file_path: "a.ts" }), "allow");
  assert.equal(permissionDecision("acceptEdits", "MultiEdit", { file_path: "a.ts" }), "allow");
  assert.equal(permissionDecision("acceptEdits", "Bash", { command: "ls" }), "prompt");
});

test("Auto-run allows edits + safe commands, prompts destructive", () => {
  assert.equal(permissionDecision("auto", "Edit", { file_path: "a.ts" }), "allow");
  assert.equal(permissionDecision("auto", "Bash", { command: "ls -la" }), "allow");
  assert.equal(permissionDecision("auto", "Bash", { command: "rm -rf build" }), "prompt");
  assert.equal(permissionDecision("auto", "Bash", { command: "git push origin main" }), "prompt");
});

test("MCP write tools count as edits", () => {
  assert.equal(permissionDecision("confined-agent", "mcp__gitview__saveFile", { path: "a.ts" }), "prompt");
  assert.equal(permissionDecision("acceptEdits", "mcp__gitview__saveFile", { path: "a.ts" }), "allow");
});
