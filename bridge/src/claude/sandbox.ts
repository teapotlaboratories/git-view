import { homedir } from "node:os";
import type { RawConfig } from "../config.js";

/**
 * OS-level sandbox for the LOCAL-SDK agent (@anthropic-ai/sandbox-runtime — Apache-2.0, verified
 * mid-2026: bubblewrap on Linux, Seatbelt on macOS, whole-process, no container).
 *
 * Two integration points (see docs/SECURITY.md):
 *  1. remote-control provider: pass `--sandbox` to `claude remote-control` (off by default).
 *  2. local-sdk provider: the bridge process should be launched under `srt` (the sandbox-runtime
 *     CLI) so the whole agent runs confined. This module builds the config that drives it and,
 *     when available, can construct a SandboxManager programmatically.
 *
 * Config here is defense-in-depth AROUND the permission profile: `failIfUnavailable` refuses to run
 * unconfined; `denyRead` hides secrets; `allowedDomains` is a default-deny egress allowlist.
 */

export interface SandboxConfig {
  failIfUnavailable: boolean;
  filesystem: { denyRead: string[] };
  network: { allowedDomains: string[] };
}

export function buildSandboxConfig(cfg: RawConfig["claude"]["sandbox"]): SandboxConfig {
  return {
    failIfUnavailable: cfg.failIfUnavailable,
    filesystem: { denyRead: cfg.denyRead.map(expandHome) },
    network: { allowedDomains: cfg.allowedDomains },
  };
}

/** Best-effort programmatic SandboxManager. Returns null if the package isn't installed. */
export async function tryCreateSandboxManager(config: SandboxConfig): Promise<unknown | null> {
  try {
    // @ts-ignore optional dependency resolved at runtime
    const mod = await import("@anthropic-ai/sandbox-runtime");
    const Manager = (mod as unknown as { SandboxManager?: new (c: unknown) => unknown }).SandboxManager;
    return typeof Manager === "function" ? new Manager(config) : null;
  } catch {
    if (config.failIfUnavailable) {
      throw new Error(
        "@anthropic-ai/sandbox-runtime not installed but sandbox.failIfUnavailable=true — " +
          "install it or set claude.sandbox.enabled=false (NOT recommended for full-tool profiles).",
      );
    }
    console.warn("[sandbox] runtime not installed; local-sdk agent will run UNCONFINED (dev only)");
    return null;
  }
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? p.replace("~", homedir()) : p;
}
