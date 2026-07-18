import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoConfig } from "../config.js";
import { ApiError } from "../util/errors.js";
import { confine } from "../util/paths.js";

const exec = promisify(execFile);

/**
 * The git READ path — browse plumbing for the file tree, blobs, log, refs, diff, blame.
 * Writes live in fileService.ts (working-tree file edits) and gitWrite.ts (stage/commit/discard).
 *
 * Safety invariants (see docs/SECURITY.md):
 *  - always execFile("git", [args]) — never a shell string (no shell = no shell injection)
 *  - only the read-only subcommands below are allowed on this path
 *  - refs are validated against a safe pattern
 *  - paths are confined to the repo root via confine() (no `..` escape)
 */

const ALLOWED_SUBCOMMANDS = new Set([
  "ls-tree",
  "cat-file",
  "blame",
  "diff",
  "log",
  "show",
  "for-each-ref",
  "status",
  "rev-parse",
]);

// Control chars used as delimiters — kept out of the source as literals so the file stays plain text.
const SEP = String.fromCharCode(31); // 0x1F unit separator, injected into --pretty and split back out
const NUL = String.fromCharCode(0); // used to sniff binary blobs

// Conservative ref validation: branch/tag/sha/HEAD, no spaces, no leading dash, no `..` tricks.
const REF_RE = /^(?!-)[A-Za-z0-9._\/-]{1,255}$/;

function assertRef(ref: string): string {
  if (!REF_RE.test(ref) || ref.includes("..")) {
    throw new ApiError("bad_ref", `invalid ref: ${ref}`);
  }
  return ref;
}

const relIn = (repo: RepoConfig, p: string) => confine(repo.path, p).rel;

async function git(repo: RepoConfig, args: string[]): Promise<string> {
  const sub = args[0];
  if (!sub || !ALLOWED_SUBCOMMANDS.has(sub)) {
    throw new ApiError("path_denied", `git subcommand not allowed: ${sub}`);
  }
  try {
    const { stdout } = await exec("git", ["-C", repo.path, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const msg = (err as { stderr?: string; message?: string }).stderr ?? (err as Error).message;
    throw new ApiError("internal", `git ${sub} failed: ${msg}`);
  }
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "blob" | "tree";
  size?: number;
  sha: string;
}

export const GitService = {
  async refs(repo: RepoConfig) {
    const list = async (glob: string) =>
      (await git(repo, ["for-each-ref", "--format=%(refname:short)", glob]))
        .split("\n")
        .filter(Boolean);
    const [branches, tags] = await Promise.all([list("refs/heads"), list("refs/tags")]);
    return { branches, tags };
  },

  async tree(repo: RepoConfig, ref: string, path = ""): Promise<TreeEntry[]> {
    assertRef(ref);
    const rel = path ? relIn(repo, path) : "";
    const spec = rel ? `${ref}:${rel}` : ref;
    // ls-tree with `-l` includes blob sizes.
    const out = await git(repo, ["ls-tree", "-l", "--full-tree", spec]);
    const entries: TreeEntry[] = [];
    for (const line of out.split("\n").filter(Boolean)) {
      // <mode> SP <type> SP <sha> SP* <size> TAB <name>
      const [meta, name] = line.split("\t");
      if (!meta || !name) continue;
      const parts = meta.split(/\s+/);
      const type = parts[1] as "blob" | "tree";
      const sha = parts[2] ?? "";
      const sizeStr = parts[3];
      entries.push({
        name,
        path: rel ? `${rel}/${name}` : name,
        type,
        sha,
        size: sizeStr && sizeStr !== "-" ? Number(sizeStr) : undefined,
      });
    }
    // dirs first, then files, each alphabetical
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1,
    );
    return entries;
  },

  async blob(repo: RepoConfig, ref: string, path: string, maxBytes: number) {
    assertRef(ref);
    const rel = relIn(repo, path);
    const spec = `${ref}:${rel}`;
    const sha = (await git(repo, ["rev-parse", spec])).trim();
    const size = Number((await git(repo, ["cat-file", "-s", spec])).trim());
    if (size > maxBytes) {
      return { path: rel, ref, sha, size, encoding: "none", binary: false, truncated: true };
    }
    // NOTE(phase-1): for correct binary handling, read the blob as a Buffer
    // (execFile with encoding:"buffer") rather than a utf-8 string. This scaffold
    // treats a NUL byte in the first 8KB as "binary".
    const content = await git(repo, ["cat-file", "-p", spec]);
    const binary = content.slice(0, 8192).includes(NUL);
    return {
      path: rel,
      ref,
      sha,
      size,
      encoding: binary ? "base64" : "utf-8",
      binary,
      truncated: false,
      content: binary ? Buffer.from(content, "binary").toString("base64") : content,
    };
  },

  async log(repo: RepoConfig, ref: string, path: string | undefined, limit = 50) {
    assertRef(ref);
    const args = [
      "log",
      `--max-count=${Math.min(limit, 200)}`,
      `--pretty=format:%H${SEP}%an${SEP}%ad${SEP}%s`,
      "--date=iso-strict",
      ref,
    ];
    if (path) args.push("--", relIn(repo, path));
    const out = await git(repo, args);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, author, date, subject] = l.split(SEP);
        return { sha, author, date, subject };
      });
  },

  // TODO(phase-1): diff (worktree/staged/base..head), blame --porcelain, show <sha>, status --porcelain=v2.
};
