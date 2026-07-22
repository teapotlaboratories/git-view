import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, mapSessionMessages } from "../src/claude/sessionManager.js";
import type { Config, RepoConfig } from "../src/config.js";
import { FileService } from "../src/git/fileService.js";
import { GitWrite } from "../src/git/gitWrite.js";
import { AuditLog } from "../src/util/audit.js";
import { ClaudeSettingsStore } from "../src/claude/settingsStore.js";
import type { TranscriptMessage } from "../src/wire.js";

const repo = { id: "r", name: "r", path: "/tmp/does-not-matter", provider: "local-sdk", profile: "auto" } as RepoConfig;

const claude = {
  defaultProvider: "local-sdk",
  defaultProfile: "auto",
  sandbox: { enabled: false, failIfUnavailable: false, denyRead: [], allowedDomains: [] },
} as unknown as Config["claude"];

function manager(): SessionManager {
  const audit = new AuditLog("/tmp/gv-transcript-audit.log");
  const settings = new ClaudeSettingsStore("/tmp/gv-transcript-claude-settings.json", "claude-opus-4-8");
  return new SessionManager(claude, new FileService(8 * 1024 * 1024, audit), new GitWrite(audit), settings);
}

test("assistant text + tool_use in one message keep order (text collapsed, tool recorded)", () => {
  const raw = [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me " },
          { type: "text", text: "look." },
          { type: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } },
        ],
      },
    },
  ];
  const out = mapSessionMessages(raw);
  assert.deepEqual(out, [
    { role: "assistant", text: "Let me look." }, // contiguous text blocks collapsed into ONE item
    { role: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } },
  ] satisfies TranscriptMessage[]);
});

test("a user tool_result carrier becomes tool_result (name recovered), NOT a user bubble", () => {
  const raw = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt\nb.txt", is_error: false }] },
    },
  ];
  const out = mapSessionMessages(raw);
  assert.equal(out.length, 2);
  const tr = out[1];
  assert.equal(tr?.role, "tool_result");
  assert.equal((tr as Extract<TranscriptMessage, { role: "tool_result" }>).id, "t1");
  assert.equal((tr as Extract<TranscriptMessage, { role: "tool_result" }>).name, "Bash"); // recovered from prior tool_use
  assert.equal((tr as Extract<TranscriptMessage, { role: "tool_result" }>).ok, true);
  assert.equal((tr as Extract<TranscriptMessage, { role: "tool_result" }>).content, "a.txt\nb.txt");
  assert.ok(!out.some((m) => m.role === "user"), "no user bubble emitted for a tool_result carrier");
});

test("is_error tool_result is marked ok:false", () => {
  const raw = [
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "x", content: "boom failed", is_error: true }] },
    },
  ];
  const out = mapSessionMessages(raw);
  assert.equal(out[0]?.role, "tool_result");
  assert.equal((out[0] as Extract<TranscriptMessage, { role: "tool_result" }>).ok, false);
  assert.equal((out[0] as Extract<TranscriptMessage, { role: "tool_result" }>).name, ""); // no prior tool_use -> empty
});

test("a real user prompt (string content) -> user text", () => {
  const out = mapSessionMessages([{ type: "user", message: { content: "hello there" } }]);
  assert.deepEqual(out, [{ role: "user", text: "hello there" }]);
});

test("a real user prompt (text blocks, no tool_result) -> user text", () => {
  const out = mapSessionMessages([
    { type: "user", message: { content: [{ type: "text", text: "fix " }, { type: "text", text: "the bug" }] } },
  ]);
  assert.deepEqual(out, [{ role: "user", text: "fix the bug" }]);
});

test("thinking blocks and system messages are skipped", () => {
  const raw = [
    { type: "system", subtype: "init", session_id: "s1" },
    {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Done." }] },
    },
    { type: "system", subtype: "other" },
  ];
  const out = mapSessionMessages(raw);
  assert.deepEqual(out, [{ role: "assistant", text: "Done." }]);
});

test("separate assistant text blocks split by a tool_use are separate items", () => {
  const raw = [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "First." },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "text", text: "Second." },
        ],
      },
    },
  ];
  const out = mapSessionMessages(raw);
  assert.deepEqual(out, [
    { role: "assistant", text: "First." },
    { role: "tool_use", id: "t1", name: "Read", input: {} },
    { role: "assistant", text: "Second." },
  ] satisfies TranscriptMessage[]);
});

test("messagesForRepo degrades to empty when the SDK lacks getSessionMessages", async () => {
  const mgr = manager();
  // The real @anthropic-ai/claude-agent-sdk is not installed in the test env, so this.sdk() import fails ->
  // degrades to an empty transcript (mirrors listForRepo).
  const res = await mgr.messagesForRepo(repo, "sess-123");
  assert.deepEqual(res, { sessionId: "sess-123", messages: [] });
});

test("messagesForRepo drives a fake sdk.getSessionMessages and maps its output", async () => {
  const mgr = manager();
  let seenDir: unknown;
  let seenCwd: unknown;
  // Inject a fake SDK by overriding the private sdk() loader.
  (mgr as unknown as { sdk: () => Promise<unknown> }).sdk = async () => ({
    getSessionMessages: async (_id: string, options?: Record<string, unknown>) => {
      seenDir = options?.["dir"];
      seenCwd = options?.["cwd"];
      return [
        { type: "user", message: { content: "hi" } },
        { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      ];
    },
  });
  const res = await mgr.messagesForRepo(repo, "sess-9");
  assert.equal(seenDir, repo.path, "options.dir is the repo path (NOT cwd)");
  assert.equal(seenCwd, undefined, "cwd is not passed (would be ignored + search all projects)");
  assert.deepEqual(res, {
    sessionId: "sess-9",
    messages: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ],
  });
});
