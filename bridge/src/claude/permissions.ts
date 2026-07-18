import type { PermissionProfile } from "../wire.js";

/**
 * Maps a GitView permission PROFILE onto Claude Agent SDK query() options.
 *
 * Research-backed choices (see docs/DECISIONS.md ADR-012, verified mid-2026):
 *  - `permissionMode` accepts: default | dontAsk | acceptEdits | bypassPermissions | plan | auto.
 *  - `auto` = a model classifier approves/denies each tool call (no prompt). It is GitView's DEFAULT.
 *  - The "confined-agent" profile is built from `allowedTools` (whitelist) + bare-name
 *    `disallowedTools` (which REMOVE a tool from context) — NOT `tools: []`. The claim that
 *    `tools: []` drops built-ins did not survive verification, so we don't rely on it.
 *  - A scoped `disallowedTools` rule (e.g. "Bash(rm *)") is enforced in EVERY mode incl. bypass.
 *  - `bypassPermissions` additionally requires `allowDangerouslySkipPermissions: true`, must not run
 *    as root, and is NOT restored on resume (we re-assert it at every launch).
 *
 * These option names are pinned to the SDK version in package.json. Re-verify on upgrade.
 */

export interface SdkPermissionOptions {
  permissionMode: "default" | "dontAsk" | "acceptEdits" | "bypassPermissions" | "plan" | "auto";
  allowedTools?: string[];
  disallowedTools?: string[];
  allowDangerouslySkipPermissions?: boolean;
}

const MCP_WILDCARD = "mcp__gitview__*";

/** Bare tool names remove the tool from Claude's context entirely (verified behavior). */
const DROP_BUILTIN_WRITES = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch"];

/** Scoped deny rules that hold even under bypassPermissions — a hard backstop layer. */
export const HARD_DENY_RULES = [
  "Bash(rm -rf /*)",
  "Bash(rm -rf ~*)",
  "Bash(:(){*)", // fork bomb
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
];

export function optionsForProfile(profile: PermissionProfile): SdkPermissionOptions {
  switch (profile) {
    case "read-only":
      return {
        permissionMode: "dontAsk",
        allowedTools: ["Read", "Glob", "Grep"],
        disallowedTools: [...DROP_BUILTIN_WRITES, ...HARD_DENY_RULES],
      };

    case "confined-agent":
      // Writes flow ONLY through the audited MCP surface (mcp__gitview__*). Built-in write tools are
      // dropped from context; dontAsk denies anything else without prompting.
      return {
        permissionMode: "dontAsk",
        allowedTools: [MCP_WILDCARD, "Read", "Grep"],
        disallowedTools: [...DROP_BUILTIN_WRITES, ...HARD_DENY_RULES],
      };

    case "acceptEdits":
      return {
        permissionMode: "acceptEdits",
        disallowedTools: HARD_DENY_RULES,
      };

    case "auto":
      // DEFAULT. No prompts; a model classifier gates each call. Defense-in-depth, not a hard boundary.
      return {
        permissionMode: "auto",
        disallowedTools: HARD_DENY_RULES,
      };

    case "dontAsk":
      return {
        permissionMode: "dontAsk",
        allowedTools: [MCP_WILDCARD, "Read", "Glob", "Grep"],
        disallowedTools: HARD_DENY_RULES,
      };

    case "bypassPermissions":
      assertNotRoot();
      return {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true, // re-asserted here at every launch (not restored on resume)
        disallowedTools: HARD_DENY_RULES, // scoped denies still bite in bypass mode
      };
  }
}

function assertNotRoot(): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === 0) {
    throw new Error("bypassPermissions must not run as root — start the bridge as an unprivileged user");
  }
}

/**
 * A PreToolUse hook is the last-resort backstop: it runs BEFORE every other permission step and a
 * `deny` here applies even in bypassPermissions mode (verified). This returns a hook-shaped callback;
 * the sessionManager wires it into query() options under `hooks.PreToolUse`.
 */
export function preToolUseDenyHook() {
  return async (input: { tool_name?: string; tool_input?: Record<string, unknown> }) => {
    const name = input.tool_name ?? "";
    const cmd = String(input.tool_input?.["command"] ?? "");
    if (name === "Bash" && /\brm\s+-rf\s+[/~]/.test(cmd)) {
      return { decision: "deny" as const, reason: "blocked destructive rm by GitView backstop" };
    }
    return { decision: "allow" as const };
  };
}
