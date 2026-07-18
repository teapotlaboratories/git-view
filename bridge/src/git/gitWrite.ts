import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoConfig } from "../config.js";
import { ApiError } from "../util/errors.js";
import { confine } from "../util/paths.js";

const exec = promisify(execFile);

/**
 * Git WRITE operations for the in-app editor: stage, commit, and discard changes in the working tree.
 * Separate from gitService.ts (reads) so the write surface is explicit and small.
 *
 * Safety: execFile only (no shell); a fixed subcommand allowlist; every path confined to the repo.
 * These mutate the repo — that is intended now (full read/write). See docs/SECURITY.md.
 */

const ALLOWED_WRITE = new Set(["add", "commit", "restore", "rm", "mv"]);

async function git(repo: RepoConfig, args: string[]): Promise<string> {
  const sub = args[0];
  if (!sub || !ALLOWED_WRITE.has(sub)) {
    throw new ApiError("path_denied", `git write subcommand not allowed: ${sub}`);
  }
  try {
    const { stdout } = await exec("git", ["-C", repo.path, ...args], { windowsHide: true });
    return stdout;
  } catch (err) {
    const msg = (err as { stderr?: string; message?: string }).stderr ?? (err as Error).message;
    throw new ApiError("internal", `git ${sub} failed: ${msg}`);
  }
}

const relOf = (repo: RepoConfig, p: string) => confine(repo.path, p).rel;

export const GitWrite = {
  /** Stage specific paths (or all with paths=["."], if you really mean it). */
  async stage(repo: RepoConfig, paths: string[]) {
    const rels = paths.map((p) => relOf(repo, p));
    await git(repo, ["add", "--", ...rels]);
    return { staged: rels };
  },

  /** Commit. If paths are given, stages them first; otherwise commits what is already staged. */
  async commit(repo: RepoConfig, message: string, paths?: string[]) {
    if (!message.trim()) throw new ApiError("bad_ref", "commit message required");
    if (paths?.length) await this.stage(repo, paths);
    const out = await git(repo, ["commit", "-m", message]);
    return { committed: true, output: out.trim() };
  },

  /** Discard working-tree changes for the given paths (git restore). */
  async discard(repo: RepoConfig, paths: string[]) {
    const rels = paths.map((p) => relOf(repo, p));
    await git(repo, ["restore", "--", ...rels]);
    return { discarded: rels };
  },
};
