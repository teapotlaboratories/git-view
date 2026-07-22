import { mkdir as fsMkdir, lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config, WorkspaceRoot } from "../config.js";
import { conflict, notFound, pathEscape } from "../util/errors.js";
import { confine, toPosix } from "../util/paths.js";

/**
 * Host-filesystem browse, CONFINED to the configured `workspaceRoots`. Every caller-supplied path is
 * routed through `confine()` against the trusted absolute root, so `..`, absolute paths, and
 * symlink-escapes are rejected exactly as they are for repo reads/writes. Roots are owner-declared, so
 * (unlike the repo browse) dotfiles ARE shown and .gitignore is NOT consulted.
 */

export type EntryKind = "dir" | "file";
export interface FsEntry {
  name: string;
  kind: EntryKind;
  isRepo?: boolean;
}
export interface FsListing {
  root: string;
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

function rootOrThrow(cfg: Config, rootId: string): WorkspaceRoot {
  const r = cfg.rootById(rootId);
  if (!r) throw notFound(`root not found: ${rootId}`);
  return r;
}

/** The configured roots, as returned by GET /v1/fs/roots. */
export function roots(cfg: Config): WorkspaceRoot[] {
  return cfg.rootsList();
}

/** List a directory inside a root. `rel` "" means the root itself; dirs first, then files, name-sorted. */
export async function list(cfg: Config, rootId: string, rel: string): Promise<FsListing> {
  const root = rootOrThrow(cfg, rootId);
  const abs = await confine(root.path, rel || ".");

  let dirents;
  try {
    dirents = await readdir(abs, { withFileTypes: true });
  } catch {
    throw notFound(`directory not found: ${rel || "/"}`);
  }

  const entries: FsEntry[] = [];
  for (const d of dirents) {
    let kind: EntryKind;
    if (d.isDirectory()) kind = "dir";
    else if (d.isFile()) kind = "file";
    else if (d.isSymbolicLink()) {
      // Do NOT follow symlinks in the host browser: following (stat) would disclose the type — and, via
      // the .git probe below, the repo-ness — of a target OUTSIDE the root, even though browsing INTO it
      // is already rejected by confine(). Show the link as a non-navigable file instead.
      kind = "file";
    } else continue; // sockets, fifos, devices — not browsable
    const entry: FsEntry = { name: d.name, kind };
    if (kind === "dir") {
      // lstat (no-follow): a real child dir may hold a `.git` dir OR a `.git` file (worktrees/submodules);
      // either counts as a repo, and no-follow avoids disclosing a symlinked-out `.git` target.
      const isRepo = await lstat(join(abs, d.name, ".git")).then(() => true, () => false);
      if (isRepo) entry.isRepo = true;
    }
    entries.push(entry);
  }
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
  );

  return { root: rootId, path: rel, parent: parentOf(rel), entries };
}

/** Create a single new child directory inside a root. No-clobber, and `name` may not traverse. */
export async function mkdir(cfg: Config, rootId: string, rel: string, name: string): Promise<{ path: string }> {
  const root = rootOrThrow(cfg, rootId);
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw pathEscape("invalid directory name");
  }
  const childRel = rel ? `${toPosix(rel)}/${name}` : name;
  const abs = await confine(root.path, childRel, /* mustExist */ false);
  // lstat (no-follow) so an existing dangling symlink at this name is also treated as a clobber.
  if (await lstat(abs).then(() => true, () => false)) throw conflict(`already exists: ${childRel}`);
  await fsMkdir(abs); // non-recursive: parent must already exist (it was just browsed)
  return { path: childRel };
}

/** parent rel-path: null at the root, "" for a first-level dir, else the parent dir. */
function parentOf(rel: string): string | null {
  if (!rel) return null;
  const p = dirname(toPosix(rel));
  return p === "." || p === "/" ? "" : p;
}
