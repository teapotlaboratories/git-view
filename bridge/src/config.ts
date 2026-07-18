import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
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
    .object({ tokensFile: z.string().default("./.gitview/tokens.json") })
    .default({ tokensFile: "./.gitview/tokens.json" }),
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
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        denyRead: ["~/.ssh", "~/.aws"],
        allowedDomains: ["api.anthropic.com"],
      },
    }),
  repos: z.array(repoSchema).min(1),
});

export type RawConfig = z.infer<typeof configSchema>;

export interface RepoConfig {
  id: string;
  name: string;
  path: string; // absolute, expanded
  provider: SessionProvider;
  profile: PermissionProfile;
}

export interface Config {
  bind: string;
  port: number;
  tokensFile: string;
  bodyLimitBytes: number;
  writeSizeCapBytes: number;
  auditFile: string;
  claude: RawConfig["claude"];
  repos: RepoConfig[];
  repoById(id: string): RepoConfig | undefined;
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

  return {
    bind: raw.bind,
    port: raw.port,
    tokensFile: expandPath(raw.auth.tokensFile, baseDir),
    bodyLimitBytes: raw.limits.bodyLimitBytes,
    writeSizeCapBytes: raw.limits.writeSizeCapBytes,
    auditFile: expandPath(raw.audit.file, baseDir),
    claude: raw.claude,
    repos,
    repoById(id: string) {
      return repos.find((r) => r.id === id);
    },
  };
}
