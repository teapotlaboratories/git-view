import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { PermissionProfile, SessionProvider } from "./wire.js";

const providerSchema = z.enum(["remote-control", "local-sdk"]);
const profileSchema = z.enum([
  "read-only",
  "confined-agent",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);

const repoSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/, "repo id must be filename-safe"),
  path: z.string().min(1),
  provider: providerSchema.optional(),
  profile: profileSchema.optional(),
});

const configSchema = z.object({
  bind: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(8787),
  auth: z
    .object({
      tokensFile: z.string().default("./.gitview/tokens.json"),
      // How long a printed pairing code stays valid. Short by default (codes are single-use); raise it
      // when the person pairing isn't sitting at the host console.
      pairingCodeTtlMinutes: z.number().positive().default(10),
    })
    .default({ tokensFile: "./.gitview/tokens.json", pairingCodeTtlMinutes: 10 }),
  limits: z
    .object({
      bodyLimitBytes: z.number().int().positive().default(10 * 1024 * 1024),
      writeSizeCapBytes: z.number().int().positive().default(8 * 1024 * 1024),
    })
    .default({ bodyLimitBytes: 10 * 1024 * 1024, writeSizeCapBytes: 8 * 1024 * 1024 }),
  audit: z
    .object({ file: z.string().default("./.gitview/audit.log") })
    .default({ file: "./.gitview/audit.log" }),
  claude: z
    .object({
      defaultProvider: providerSchema.default("local-sdk"),
      defaultProfile: profileSchema.default("auto"),
      // Effective SDK model for host-agent queries (overridable at runtime via /v1/claude/settings).
      model: z.string().default("claude-opus-4-8"),
      maxBudgetUsd: z.number().positive().optional(),
      sandbox: z
        .object({
          enabled: z.boolean().default(true),
          failIfUnavailable: z.boolean().default(true),
          denyRead: z.array(z.string()).default(["~/.ssh", "~/.aws"]),
          allowedDomains: z.array(z.string()).default(["api.anthropic.com"]),
        })
        .default({
          enabled: true,
          failIfUnavailable: true,
          denyRead: ["~/.ssh", "~/.aws"],
          allowedDomains: ["api.anthropic.com"],
        }),
    })
    .default({
      defaultProvider: "local-sdk",
      defaultProfile: "auto",
      model: "claude-opus-4-8",
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        denyRead: ["~/.ssh", "~/.aws"],
        allowedDomains: ["api.anthropic.com"],
      },
    }),
  // May be empty: a fresh install (e.g. the .deb, which ships `repos: []`) starts with none and the
  // operator adds repos later or browses-to-open workspaces. Requiring ≥1 made the packaged bridge
  // crash-loop out of the box.
  repos: z.array(repoSchema).default([]),
  // Host directories the app may browse + open folders inside as workspaces. Empty => feature off.
  workspaceRoots: z.array(z.string()).default([]),
});

export type RawConfig = z.infer<typeof configSchema>;

export interface RepoConfig {
  id: string;
  name: string;
  path: string; // absolute, expanded
  provider: SessionProvider;
  profile: PermissionProfile;
}

/** A configured, browsable host root. `id` is a stable, filename-safe slug of the directory basename. */
export interface WorkspaceRoot {
  id: string;
  path: string; // absolute, expanded
  label: string; // the directory basename, shown in the app
}

export interface Config {
  bind: string;
  port: number;
  tokensFile: string;
  pairingCodeTtlMs: number;
  workspacesFile: string;
  bodyLimitBytes: number;
  writeSizeCapBytes: number;
  auditFile: string;
  claude: RawConfig["claude"];
  // Absolute path to the in-app model/credential overrides store (.gitview/claude-settings.json).
  claudeSettingsFile: string;
  repos: RepoConfig[];
  repoById(id: string): RepoConfig | undefined;
  // Workspace-browse feature. `workspaceRoots` is the absolute path list; empty => feature off.
  workspaceRoots: string[];
  workspacesEnabled: boolean;
  rootsList(): WorkspaceRoot[];
  rootById(id: string): WorkspaceRoot | undefined;
}

/** Turn a directory basename into a filename-safe slug for use as a stable root/workspace id. */
export function slugifyId(name: string): string {
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  return slug || "root";
}

/** Expand a leading `~` and resolve to an absolute path against the config file's directory. */
export function expandPath(p: string, baseDir: string): string {
  let out = p;
  if (out === "~" || out.startsWith("~/")) out = out.replace("~", homedir());
  return isAbsolute(out) ? out : resolve(baseDir, out);
}

export async function loadConfig(configPath: string): Promise<Config> {
  const baseDir = resolve(configPath, "..");
  const raw = configSchema.parse(parseYaml(await readFile(configPath, "utf-8")));

  const repos: RepoConfig[] = raw.repos.map((r) => ({
    id: r.id,
    name: r.id,
    path: expandPath(r.path, baseDir),
    provider: r.provider ?? raw.claude.defaultProvider,
    profile: r.profile ?? raw.claude.defaultProfile,
  }));

  // Expand each root, derive a stable slug id from its basename, and de-dupe collisions (`x`, `x-2`, ...).
  const rootPaths = raw.workspaceRoots.map((p) => expandPath(p, baseDir));
  const taken = new Set<string>();
  const roots: WorkspaceRoot[] = rootPaths.map((path) => {
    const label = basename(path);
    let id = slugifyId(label);
    let n = 2;
    while (taken.has(id)) id = `${slugifyId(label)}-${n++}`;
    taken.add(id);
    return { id, path, label };
  });

  const tokensFile = expandPath(raw.auth.tokensFile, baseDir);

  return {
    bind: raw.bind,
    port: raw.port,
    tokensFile,
    pairingCodeTtlMs: raw.auth.pairingCodeTtlMinutes * 60_000,
    // The workspace store lives beside tokens.json (same 0600 .gitview control dir).
    workspacesFile: join(dirname(tokensFile), "workspaces.json"),
    bodyLimitBytes: raw.limits.bodyLimitBytes,
    writeSizeCapBytes: raw.limits.writeSizeCapBytes,
    auditFile: expandPath(raw.audit.file, baseDir),
    claude: raw.claude,
    // Beside tokens.json (same 0600 .gitview control dir) so a single tokensFile override relocates ALL
    // runtime state — otherwise this defaults under the read-only /etc config dir on a .deb install.
    claudeSettingsFile: join(dirname(tokensFile), "claude-settings.json"),
    repos,
    repoById(id: string) {
      return repos.find((r) => r.id === id);
    },
    workspaceRoots: roots.map((r) => r.path),
    workspacesEnabled: roots.length > 0,
    rootsList() {
      return roots;
    },
    rootById(id: string) {
      return roots.find((r) => r.id === id);
    },
  };
}
