import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, relative, sep } from "node:path";
import { pathEscape } from "./errors.js";

/**
 * Path confinement. EVERY read and write must route a caller-supplied relative path through here.
 *
 * Guarantees:
 *  - rejects absolute inputs and inputs that traverse above the root (`..`),
 *  - resolves symlinks with realpath and RE-CHECKS containment, so a symlink inside the repo that
 *    points outside it cannot be used to escape.
 *
 * `mustExist=false` (for creates) realpaths the nearest existing ancestor instead of the leaf, so a
 * not-yet-created file still gets symlink-escape checking on its parent chain.
 */
export async function confine(root: string, rel: string, mustExist = true): Promise<string> {
  if (isAbsolute(rel)) throw pathEscape("absolute paths are not allowed");

  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, rel);

  // Lexical containment check first (cheap, catches `..` before any fs call).
  if (!isInside(rootReal, candidate)) throw pathEscape();

  // Symlink-resolving check. Realpath the deepest existing path on the chain.
  const existing = mustExist ? candidate : await nearestExisting(candidate);
  const real = await realpath(existing).catch(() => existing);
  if (!isInside(rootReal, real)) throw pathEscape("resolved outside the repository (symlink escape)");

  return candidate;
}

export function isInside(root: string, p: string): boolean {
  if (p === root) return true;
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function nearestExisting(p: string): Promise<string> {
  let cur = p;
  // Walk up until realpath succeeds (the parent that already exists on disk).
  for (;;) {
    try {
      await realpath(cur);
      return cur;
    } catch {
      const parent = resolve(cur, "..");
      if (parent === cur) return cur; // reached fs root
      cur = parent;
    }
  }
}

/** Normalize a path for logging/keys without touching the fs. */
export function toPosix(rel: string): string {
  return rel.split(sep).join("/");
}
