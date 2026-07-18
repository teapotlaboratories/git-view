import { writeFile, readFile, mkdir, rm, rename, access, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { RepoConfig } from "../config.js";
import { ApiError } from "../util/errors.js";
import { confine } from "../util/paths.js";

/**
 * The WRITE path for direct in-app editing. Operates on the repo's WORKING TREE (files on disk
 * at the current checkout) — not on historical refs, which are immutable and stay read-only.
 *
 * Every path is confined to the repo root (see util/paths.ts). With "direct, no prompts" writes,
 * confinement + auth are the security boundary — see docs/SECURITY.md.
 */

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

function decode(content: string, encoding: "utf-8" | "base64"): Buffer {
  return encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf-8");
}

export const FileService = {
  /** Overwrite (or create) a file in the working tree. */
  async save(repo: RepoConfig, path: string, content: string, encoding: "utf-8" | "base64" = "utf-8") {
    const { abs, rel } = confine(repo.path, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, decode(content, encoding));
    const s = await stat(abs);
    return { path: rel, size: s.size, savedAt: s.mtime.toISOString() };
  },

  /** Create a new file; fails if it already exists. */
  async create(repo: RepoConfig, path: string, content = "", encoding: "utf-8" | "base64" = "utf-8") {
    const { abs, rel } = confine(repo.path, path);
    if (await exists(abs)) throw new ApiError("path_denied", `already exists: ${rel}`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, decode(content, encoding));
    return { path: rel, created: true };
  },

  /** Delete a file or directory (recursive). */
  async remove(repo: RepoConfig, path: string) {
    const { abs, rel } = confine(repo.path, path);
    if (!(await exists(abs))) throw new ApiError("not_found", `no such path: ${rel}`);
    await rm(abs, { recursive: true, force: true });
    return { path: rel, removed: true };
  },

  /** Rename / move within the repo. */
  async rename(repo: RepoConfig, from: string, to: string) {
    const src = confine(repo.path, from);
    const dst = confine(repo.path, to);
    if (!(await exists(src.abs))) throw new ApiError("not_found", `no such path: ${src.rel}`);
    await mkdir(dirname(dst.abs), { recursive: true });
    await rename(src.abs, dst.abs);
    return { from: src.rel, to: dst.rel };
  },

  /** Read the working-tree version of a file (what the editor edits), as opposed to a committed ref. */
  async readWorking(repo: RepoConfig, path: string, maxBytes: number) {
    const { abs, rel } = confine(repo.path, path);
    if (!(await exists(abs))) throw new ApiError("not_found", `no such path: ${rel}`);
    const s = await stat(abs);
    if (s.size > maxBytes) return { path: rel, size: s.size, truncated: true, encoding: "none" as const };
    const buf = await readFile(abs);
    const binary = buf.subarray(0, 8192).includes(0);
    return {
      path: rel,
      size: s.size,
      truncated: false,
      encoding: binary ? ("base64" as const) : ("utf-8" as const),
      binary,
      content: binary ? buf.toString("base64") : buf.toString("utf-8"),
    };
  },
};
