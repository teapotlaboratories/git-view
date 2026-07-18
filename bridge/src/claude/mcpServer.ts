import { z } from "zod";
import type { RepoConfig } from "../config.js";
import type { FileService } from "../git/fileService.js";
import type { GitWrite } from "../git/gitWrite.js";
import { readBlob, status, WORKTREE } from "../git/gitService.js";

/**
 * The ONE audited write surface (req. D). Exposes the bridge's path-confined git/file operations as
 * an IN-PROCESS SDK MCP server. The "confined-agent" profile whitelists `mcp__gitview__*` + Read +
 * Grep and drops built-in write tools, so Claude writes through the SAME confined, size-capped,
 * audited path as the app — no raw Bash/Write, no bypass needed.
 *
 * Tools are auto-namespaced `mcp__gitview__<tool>` by the SDK (verified). `createSdkMcpServer` and
 * `tool` are loaded via dynamic import so this module compiles without the optional SDK installed.
 */

interface SdkToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const ok = (text: string): SdkToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): SdkToolResult => ({ content: [{ type: "text", text }], isError: true });

export interface McpDeps {
  repo: RepoConfig;
  files: FileService;
  gitWrite: GitWrite;
}

/** Returns an SDK MCP server object, or null if the SDK isn't installed. */
export async function createGitViewMcpServer(deps: McpDeps): Promise<unknown | null> {
  let sdk: { createSdkMcpServer?: Function; tool?: Function };
  try {
    // @ts-ignore optional dependency resolved at runtime
    sdk = await import("@anthropic-ai/claude-agent-sdk");
  } catch {
    console.warn("[mcp] @anthropic-ai/claude-agent-sdk not installed — confined-agent profile unavailable");
    return null;
  }
  const { createSdkMcpServer, tool } = sdk;
  if (!createSdkMcpServer || !tool) return null;

  const { repo, files, gitWrite } = deps;
  const root = repo.path;
  const actor = "claude" as const;

  const tools = [
    tool("readFile", "Read a file from the repository working tree or a historical ref.",
      { path: z.string(), ref: z.string().optional() },
      async (a: { path: string; ref?: string }) => {
        const blob = await readBlob(root, a.ref ?? WORKTREE, a.path);
        return ok(blob.binary ? `[binary ${blob.size} bytes, base64]\n${blob.content}` : blob.content);
      }),

    tool("saveFile", "Overwrite an existing file in the working tree.",
      { path: z.string(), content: z.string(), encoding: z.enum(["utf-8", "base64"]).optional() },
      async (a: { path: string; content: string; encoding?: "utf-8" | "base64" }) => {
        await files.save(repo.id, root, a.path, a.content, a.encoding ?? "utf-8", actor);
        return ok(`saved ${a.path}`);
      }),

    tool("createFile", "Create a new file in the working tree.",
      { path: z.string(), content: z.string(), encoding: z.enum(["utf-8", "base64"]).optional() },
      async (a: { path: string; content: string; encoding?: "utf-8" | "base64" }) => {
        await files.create(repo.id, root, a.path, a.content, a.encoding ?? "utf-8", actor);
        return ok(`created ${a.path}`);
      }),

    tool("deleteFile", "Delete a file from the working tree.",
      { path: z.string() },
      async (a: { path: string }) => {
        await files.remove(repo.id, root, a.path, actor);
        return ok(`deleted ${a.path}`);
      }),

    tool("renameFile", "Rename or move a file within the working tree.",
      { from: z.string(), to: z.string() },
      async (a: { from: string; to: string }) => {
        await files.renamePath(repo.id, root, a.from, a.to, actor);
        return ok(`renamed ${a.from} -> ${a.to}`);
      }),

    tool("stage", "Stage paths (git add).",
      { paths: z.array(z.string()).min(1) },
      async (a: { paths: string[] }) => {
        await gitWrite.stage(repo.id, root, a.paths, actor);
        return ok(`staged ${a.paths.length} path(s)`);
      }),

    tool("commit", "Commit staged changes (or the given paths) with a message.",
      { message: z.string(), paths: z.array(z.string()).optional() },
      async (a: { message: string; paths?: string[] }) => {
        const r = await gitWrite.commit(repo.id, root, a.message, a.paths, actor);
        return ok(`committed ${r.oid}`);
      }),

    tool("discard", "Discard working-tree + staged changes for paths (git restore).",
      { paths: z.array(z.string()).min(1) },
      async (a: { paths: string[] }) => {
        await gitWrite.discard(repo.id, root, a.paths, actor);
        return ok(`discarded ${a.paths.length} path(s)`);
      }),

    tool("status", "Show working-tree status.", {},
      async () => {
        const entries = await status(root);
        return ok(entries.map((e) => `${e.index}${e.worktree} ${e.path}`).join("\n") || "(clean)");
      }),
  ];

  return createSdkMcpServer({ name: "gitview", version: "0.1.0", tools });
}

// Silence "unused" for the error helper kept for symmetry/future tools.
void err;
