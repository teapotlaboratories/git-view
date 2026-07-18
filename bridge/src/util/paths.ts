import { resolve, relative, isAbsolute } from "node:path";
import { ApiError } from "./errors.js";

/**
 * Confine a repo-relative path to the repo root. Rejects `..` traversal and absolute escapes.
 *
 * This is the single most important guard now that the bridge can WRITE: it ensures every read
 * and every write stays inside the configured repo directory. Shared by the git service (reads)
 * and the file service (writes) so the confinement logic has exactly one implementation.
 *
 * NOTE: this does not resolve symlinks. If a repo may contain symlinks pointing outside itself,
 * additionally `fs.realpath` the result and re-check before writing (TODO if that risk applies).
 */
export function confine(repoRoot: string, relPath: string): { rel: string; abs: string } {
  const abs = resolve(repoRoot, relPath);
  const rel = relative(repoRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ApiError("path_denied", `path escapes repo: ${relPath}`);
  }
  return { rel, abs };
}
