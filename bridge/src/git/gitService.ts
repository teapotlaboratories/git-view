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

  /**
   * Diff. Default (no opts) = working tree vs HEAD. `staged` = index vs HEAD.
   * `base`+`head` = commit-to-commit. Returns parsed files/hunks.
   */
  async diff(repo: RepoConfig, opts: { base?: string; head?: string; staged?: boolean }) {
    const selector: string[] = [];
    let label: string;
    if (opts.staged) {
      selector.push("--cached");
      label = "staged";
    } else if (opts.base && opts.head) {
      assertRef(opts.base);
      assertRef(opts.head);
      selector.push(`${opts.base}..${opts.head}`);
      label = `${opts.base}..${opts.head}`;
    } else {
      selector.push("HEAD");
      label = "worktree";
    }
    const patch = await git(repo, ["diff", "--no-color", ...selector]);
    return { selector: label, files: parseUnifiedDiff(patch) };
  },

  async blame(repo: RepoConfig, ref: string, path: string) {
    assertRef(ref);
    const rel = relIn(repo, path);
    const out = await git(repo, ["blame", "--porcelain", ref, "--", rel]);
    const authors = new Map<string, string>();
    const lines: { line: number; sha: string; author: string; content: string }[] = [];
    let sha = "";
    let finalLine = 0;
    for (const l of out.split("\n")) {
      const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
      if (m) {
        sha = m[1]!;
        finalLine = Number(m[2]);
        continue;
      }
      if (l.startsWith("author ")) {
        authors.set(sha, l.slice("author ".length));
        continue;
      }
      if (l.startsWith("\t")) {
        lines.push({ line: finalLine, sha, author: authors.get(sha) ?? "", content: l.slice(1) });
      }
    }
    return { ref, path: rel, lines };
  },

  async status(repo: RepoConfig) {
    const out = await git(repo, ["status", "--porcelain=v2", "--branch"]);
    let branch = "";
    const entries: { code: string; path: string; origPath?: string }[] = [];
    for (const l of out.split("\n").filter(Boolean)) {
      if (l.startsWith("# branch.head ")) {
        branch = l.slice("# branch.head ".length);
        continue;
      }
      if (l.startsWith("#")) continue;
      const t = l[0];
      if (t === "1") {
        const parts = l.split(" ");
        entries.push({ code: parts[1] ?? "", path: parts.slice(8).join(" ") });
      } else if (t === "2") {
        const parts = l.split(" ");
        const rest = parts.slice(9).join(" ");
        const [path, origPath] = rest.split("\t");
        entries.push({ code: parts[1] ?? "", path: path ?? rest, origPath });
      } else if (t === "u") {
        const parts = l.split(" ");
        entries.push({ code: parts[1] ?? "uu", path: parts.slice(10).join(" ") });
      } else if (t === "?") {
        entries.push({ code: "??", path: l.slice(2) });
      }
    }
    return { branch, entries };
  },

  /** Commit detail: metadata + per-file diffs (backs GET /commits/:sha). */
  async show(repo: RepoConfig, sha: string) {
    assertRef(sha);
    const meta = (
      await git(repo, [
        "show",
        "-s",
        `--format=%H${SEP}%an${SEP}%ae${SEP}%ad${SEP}%s${SEP}%b`,
        "--date=iso-strict",
        sha,
      ])
    ).split(SEP);
    const patch = await git(repo, ["show", "--no-color", "--format=", sha]);
    return {
      sha: (meta[0] ?? sha).trim(),
      author: meta[1] ?? "",
      email: meta[2] ?? "",
      date: meta[3] ?? "",
      subject: meta[4] ?? "",
      body: (meta[5] ?? "").trim(),
      files: parseUnifiedDiff(patch),
    };
  },
};

// ---- unified-diff parsing (shared by diff() and show()) ----

interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
}
interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}

function stripAB(p: string): string {
  return p.replace(/^[ab]\//, "");
}

function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      cur = { path: "", status: "modified", additions: 0, deletions: 0, binary: false, hunks: [] };
      hunk = null;
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file")) cur.status = "added";
    else if (line.startsWith("deleted file")) cur.status = "deleted";
    else if (line.startsWith("rename from ")) {
      cur.oldPath = line.slice("rename from ".length);
      cur.status = "renamed";
    } else if (line.startsWith("rename to ")) cur.path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files")) cur.binary = true;
    else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") cur.oldPath = stripAB(p);
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") cur.path = stripAB(p);
    } else if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
    } else if (hunk) {
      if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: line.slice(1) });
        cur.additions++;
      } else if (line.startsWith("-")) {
        hunk.lines.push({ kind: "del", text: line.slice(1) });
        cur.deletions++;
      } else if (line.startsWith(" ")) {
        hunk.lines.push({ kind: "context", text: line.slice(1) });
      }
      // lines starting with "\" (no-newline marker) are ignored
    }
  }
  for (const f of files) if (!f.path && f.oldPath) f.path = f.oldPath;
  return files;
}
