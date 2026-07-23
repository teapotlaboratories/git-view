import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * Locate the Claude Code CLI that the Agent SDK should drive.
 *
 * The SDK normally ships the CLI itself, as a *platform-specific optional dependency*
 * (`@anthropic-ai/claude-agent-sdk-linux-x64` and friends — ~222MB each). The packaged .deb
 * deliberately omits those (`npm install --omit=optional`) so it stays ~4MB and
 * `Architecture: all` instead of a ~100MB build per architecture. Without a CLI the SDK fails
 * at `query()` time with "native CLI not found", so on a packaged install we point it at the
 * Claude Code already on the host — see README "Requirements".
 *
 * Order (first hit wins):
 *   1. `claude.cliPath` in config.yaml   — explicit operator override
 *   2. `$GITVIEW_CLAUDE_CLI`
 *   3. the SDK's own bundled binary, when installed (source/dev installs) — exact version match,
 *      so it's preferred over a host CLI that may be a different version
 *   4. `claude` on `PATH`
 *   5. common install locations
 * Nothing found → throw an actionable error instead of the SDK's opaque one.
 */
export interface CliResolution {
  /** Pass as `pathToClaudeCodeExecutable`; `undefined` = let the SDK use its bundled binary. */
  path?: string;
  /** Where it came from — logged once so `journalctl` shows which CLI is in use. */
  source: string;
}

/** Checked after PATH so an explicitly-installed CLI wins over a stray one. */
const COMMON_DIRS = [
  join(homedir(), ".local", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
];

const EXE = process.platform === "win32" ? "claude.exe" : "claude";

function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? p.replace("~", homedir()) : p;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The SDK's bundled platform binary, when the optional package IS installed. Resolved relative to
 * the SDK package rather than guessed, so a hoisted or nested node_modules both work. Alpine/musl
 * hosts get the `-musl` package, so both names are tried.
 */
function bundledCli(): string | null {
  const require = createRequire(import.meta.url);
  let sdkDir: string;
  try {
    sdkDir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk/package.json"));
  } catch {
    return null; // SDK absent, or it doesn't export package.json — fall through to a host CLI
  }
  const plat = `${process.platform}-${process.arch}`;
  for (const name of [`claude-agent-sdk-${plat}`, `claude-agent-sdk-${plat}-musl`]) {
    // sdkDir is .../node_modules/@anthropic-ai/claude-agent-sdk → siblings live one level up.
    const candidate = join(dirname(sdkDir), name, EXE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class ClaudeCliNotFound extends Error {
  constructor() {
    super(
      "Claude CLI not found. The bridge drives the Claude Code CLI installed on this host " +
        "(the packaged .deb does not bundle it). Install Claude Code, then restart the bridge — " +
        "or point at an existing binary with `claude.cliPath` in /etc/gitview-bridge/config.yaml " +
        "or the GITVIEW_CLAUDE_CLI environment variable. See the README (Requirements).",
    );
    this.name = "ClaudeCliNotFound";
  }
}

let logged = false;

/**
 * Search locations, overridable so tests can exercise the fallback chain deterministically (a dev
 * tree always has the bundled binary, which would otherwise short-circuit every later step).
 * Production callers pass nothing.
 */
export interface CliLookup {
  bundled?: () => string | null;
  pathDirs?: string[];
  commonDirs?: string[];
}

/** Resolve the CLI; throws {@link ClaudeCliNotFound} when nothing usable exists. */
export async function resolveClaudeCli(
  configured?: string,
  lookup: CliLookup = {},
): Promise<CliResolution> {
  const explicit: Array<[string, string | undefined]> = [
    ["claude.cliPath", configured],
    ["GITVIEW_CLAUDE_CLI", process.env["GITVIEW_CLAUDE_CLI"]?.trim() || undefined],
  ];
  for (const [source, raw] of explicit) {
    if (!raw) continue;
    const p = expandTilde(raw);
    // An explicit setting that doesn't work is a misconfiguration — say so rather than silently
    // falling back to some other CLI the operator didn't ask for.
    if (!isAbsolute(p)) throw new Error(`${source}: must be an absolute path (got "${raw}")`);
    if (!(await isExecutable(p))) throw new Error(`${source}: not an executable file: ${p}`);
    return { path: p, source };
  }

  const bundled = (lookup.bundled ?? bundledCli)();
  if (bundled) return { source: "bundled with the SDK" }; // no path → SDK uses its own

  for (const dir of lookup.pathDirs ?? (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, EXE);
    if (await isExecutable(candidate)) return { path: candidate, source: "PATH" };
  }
  for (const dir of lookup.commonDirs ?? COMMON_DIRS) {
    const candidate = join(dir, EXE);
    if (await isExecutable(candidate)) return { path: candidate, source: dir };
  }
  throw new ClaudeCliNotFound();
}

/** Resolve + log the choice once (first chat of the process), so the journal records which CLI runs. */
export async function resolveClaudeCliOnce(configured?: string): Promise<CliResolution> {
  const res = await resolveClaudeCli(configured);
  if (!logged) {
    logged = true;
    console.log(`Claude CLI: ${res.path ?? "(SDK built-in)"}  [${res.source}]`);
  }
  return res;
}
