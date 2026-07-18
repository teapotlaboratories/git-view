import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const RepoSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]+$/, "repo id must be url-safe"),
  name: z.string(),
  path: z.string(),
  defaultRef: z.string().default("main"),
});

const ConfigSchema = z.object({
  repos: z.array(RepoSchema).min(1),
  limits: z
    .object({
      maxBlobBytes: z.number().default(2_000_000),
      session: z
        .object({
          maxTurns: z.number().default(20),
          maxBudgetUsd: z.number().default(5),
          idleTimeoutMinutes: z.number().default(30),
          maxConcurrentPerRepo: z.number().default(3),
        })
        .prefault({}),
    })
    .prefault({}),
  claude: z
    .object({
      // "read-write" = full tools, direct writes, no approval prompts (the chosen default).
      // "read-only" remains available for repos you only want to inspect.
      profile: z.enum(["read-write", "read-only"]).default("read-write"),
      model: z.string().optional(),
    })
    .prefault({}),
});

export type RepoConfig = z.infer<typeof RepoSchema> & { path: string };
export type Config = z.infer<typeof ConfigSchema>;

export interface Env {
  anthropicApiKey: string | undefined;
  deviceTokenSecret: string;
  bridgeToken: string | undefined;
  port: number;
  host: string;
}

export function loadEnv(): Env {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    deviceTokenSecret: process.env.DEVICE_TOKEN_SECRET ?? "insecure-dev-secret",
    bridgeToken: process.env.BRIDGE_TOKEN,
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? "127.0.0.1",
  };
}

export function loadConfig(file = "config.yaml"): Config {
  const raw = parseYaml(readFileSync(file, "utf8"));
  const cfg = ConfigSchema.parse(raw);
  // Normalize repo paths to absolute up front so the git wrapper can confine to them.
  cfg.repos = cfg.repos.map((r) => ({ ...r, path: resolve(r.path) }));
  return cfg;
}

export function repoById(cfg: Config, id: string): RepoConfig | undefined {
  return cfg.repos.find((r) => r.id === id);
}
