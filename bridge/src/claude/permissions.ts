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
      // "Ask first" (redesign default). Built-in tools ARE available, but the interactive gate
      // (`canUseTool`, wired in sessionManager) pauses every edit & command for the user's OK. The
      // audited MCP write surface stays mounted for this profile as an additional, audited path.
      return { permissionMode: "default", disallowedTools: HARD_DENY_RULES };

    case "acceptEdits":
      // "Auto-edit": edits apply without asking; `canUseTool` pauses before any command.
      return { permissionMode: "default", disallowedTools: HARD_DENY_RULES };

    case "auto":
      // "Auto-run": edits + safe commands run; `canUseTool` pauses on destructive / outside-repo.
      return { permissionMode: "default", disallowedTools: HARD_DENY_RULES };

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

/** Interactive tiers run the `canUseTool` gate (sessionManager); the others don't prompt. */
export function isInteractive(profile: PermissionProfile): boolean {
  return profile === "confined-agent" || profile === "acceptEdits" || profile === "auto";
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoRead", "TodoWrite", "WebSearch"]);
const BUILTIN_EDITS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function toolCategory(name: string): "read" | "edit" | "command" | "other" {
  if (READ_TOOLS.has(name)) return "read";
  if (BUILTIN_EDITS.has(name)) return "edit";
  if (name.startsWith("mcp__") && /(save|write|edit|create|rename|delete|stage|commit|discard)/i.test(name)) return "edit";
  if (name === "Bash") return "command";
  return "other";
}

function isDestructiveCommand(input: Record<string, unknown> | undefined): boolean {
  const cmd = String(input?.["command"] ?? "");
  return /\b(rm|mv|dd|mkfs|chmod\s+-R|chown\s+-R|git\s+push|git\s+reset\s+--hard|git\s+clean|curl|wget)\b/.test(cmd);
}

/**
 * Per-tier decision for a tool call under the interactive gate: allow silently, PROMPT the user, or
 * deny. Reads never prompt. Mirrors the redesign permission table (docs/design handoff).
 */
export function permissionDecision(
  profile: PermissionProfile,
  toolName: string,
  input: Record<string, unknown> | undefined,
): "allow" | "prompt" | "deny" {
  if (toolCategory(toolName) === "read") return "allow";
  const cat = toolCategory(toolName);
  switch (profile) {
    case "confined-agent": // Ask first — every edit & command
      return "prompt";
    case "acceptEdits": // Auto-edit — edits auto, commands prompt
      return cat === "edit" ? "allow" : "prompt";
    case "auto": // Auto-run — edits + safe commands auto, destructive prompt
      if (cat === "edit") return "allow";
      if (cat === "command") return isDestructiveCommand(input) ? "prompt" : "allow";
      return "prompt";
    default:
      return "allow";
  }
}

function assertNotRoot(): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === 0) {
    throw new Error("bypassPermissions must not run as root — start the bridge as an unprivileged user");
  }
}

// NOTE: There used to be a `preToolUseDenyHook()` wired into query() `hooks.PreToolUse` as an extra
// rm-rf/fork-bomb backstop. It was removed 2026-07-23: passing programmatic `hooks` to
// claude-agent-sdk v0.2.x silently drops IN-PROCESS (SDK) MCP servers — it took out our whole
// `gitview` audited-write + attach_file surface. The HARD_DENY_RULES above (scoped `disallowedTools`,
// enforced in every mode incl. bypass) are a strict superset of what that hook denied, so removing it
// loses no protection. See sessionManager.ts for the guard comment. Do not re-introduce `hooks` here.
