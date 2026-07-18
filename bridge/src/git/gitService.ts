import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  BlobResponse,
  CommitSummary,
  DiffKind,
  RefsResponse,
  StatusEntry,
  TreeEntry,
  TreeResponse,
} from "../wire.js";
import { gitError, notFound } from "../util/errors.js";
import { confine } from "../util/paths.js";

const execFileAsync = promisify(execFile);

/**
 * All git access goes through here. Two invariants (see docs/SECURITY.md):
 *  1. git is invoked with execFile + an argv array — NEVER a shell string (no injection surface).
 *  2. the SUBCOMMAND (argv[0]) is checked against a fixed allowlist, and every caller-supplied ref
 *     is validated before use.
 */
const READ_SUBCOMMANDS = new Set([
  "rev-parse",
  "ls-tree",
  "cat-file",
  "log",
  "for-each-ref",
  "symbolic-ref",
  "diff",
  "diff-index",
  "blame",
  "show",
  "status",
]);

const WRITE_SUBCOMMANDS = new Set(["add", "commit", "restore", "mv", "rm"]);

const MAX_BUFFER = 64 * 1024 * 1024;

export const WORKTREE = "WORKTREE";

/** Run git in string mode (utf-8 output). Enforces the subcommand allowlist. */
export async function git(repoPath: string, args: string[]): Promise<string> {
  assertAllowed(args[0]);
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
      encoding: "utf-8",
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    throw gitError(cleanGitMessage(err));
  }
}

/** Run git in binary mode (Buffer output) — REQUIRED for blobs so images/binaries aren't corrupted. */
export async function gitBuffer(repoPath: string, args: string[]): Promise<Buffer> {
  assertAllowed(args[0]);
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
      encoding: "buffer",
      maxBuffer: MAX_BUFFER,
    });
    return stdout as Buffer;
  } catch (err) {
    throw gitError(cleanGitMessage(err));
  }
}

function assertAllowed(sub: string | undefined): void {
  if (!sub || !(READ_SUBCOMMANDS.has(sub) || WRITE_SUBCOMMANDS.has(sub))) {
    throw gitError(`git subcommand not allowed: ${sub ?? "(none)"}`);
  }
}

function cleanGitMessage(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string };
  const stderr = e.stderr ? e.stderr.toString().trim() : "";
  return stderr || e.message || "git failed";
}

/**
 * Validate + resolve a ref to a full object id. Rejects option-like inputs and anything git can't
 * verify. `WORKTREE` (or empty) means the working tree — callers handle that specially.
 */
export async function resolveRef(repoPath: string, ref: string | undefined): Promise<string> {
  if (!ref || ref === WORKTREE) return WORKTREE;
  if (ref.startsWith("-") || /[\s~^:?*[\]\\]/.test(ref)) throw gitError(`invalid ref: ${ref}`);
  try {
    return (await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
  } catch {
    // Could be a tree-ish (tag to a tree) or a raw oid; try a looser verify.
    try {
      return (await git(repoPath, ["rev-parse", "--verify", "--quiet", ref])).trim();
    } catch {
      throw notFound(`ref not found: ${ref}`);
    }
  }
}

export async function getRefs(repoPath: string): Promise<RefsResponse> {
  const head = (await git(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
  const branches = splitLines(await git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]));
  const tags = splitLines(await git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/tags"]));
  return { head: head || "HEAD", branches, tags };
}

export async function listTree(repoPath: string, ref: string, path: string): Promise<TreeResponse> {
  // The working tree must show UNTRACKED files too (this is a live editor), so list from disk.
  if (ref === WORKTREE) return listWorktree(repoPath, path);

  const resolved = ref;
  const spec = path ? `${resolved}:${path}` : resolved;
  // -l gives object size for blobs; -z NUL-separates for safe parsing.
  let raw: string;
  try {
    raw = await git(repoPath, ["ls-tree", "-l", "-z", spec, "--"]);
  } catch {
    throw notFound(`tree not found: ${path || "/"} @ ${ref}`);
  }
  const entries: TreeEntry[] = [];
  for (const rec of raw.split("\0")) {
    if (!rec) continue;
    // format: "<mode> <type> <oid> <size>\t<name>"
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(/\s+/);
    const name = rec.slice(tab + 1);
    const type = meta[1] === "tree" ? "tree" : "blob";
    const size = meta[3] && meta[3] !== "-" ? Number(meta[3]) : undefined;
    entries.push({
      name,
      path: path ? `${path}/${name}` : name,
      type,
      oid: meta[2] ?? "",
      ...(size !== undefined ? { size } : {}),
    });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1));
  return { ref, path, entries };
}

/** List a working-tree directory from disk (includes untracked files; skips .git). */
async function listWorktree(repoPath: string, path: string): Promise<TreeResponse> {
  const dir = await confine(repoPath, path || ".");
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    throw notFound(`directory not found: ${path || "/"}`);
  }
  const entries: TreeEntry[] = [];
  for (const d of dirents) {
    if (path === "" && d.name === ".git") continue;
    const rel = path ? `${path}/${d.name}` : d.name;
    const type = d.isDirectory() ? "tree" : "blob";
    let size: number | undefined;
    if (type === "blob") {
      size = await stat(join(dir, d.name)).then((s) => s.size).catch(() => undefined);
    }
    entries.push({ name: d.name, path: rel, type, oid: "", ...(size !== undefined ? { size } : {}) });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1));
  return { ref: WORKTREE, path, entries };
}

export async function readBlob(repoPath: string, ref: string, path: string): Promise<BlobResponse> {
  const abs = await confine(repoPath, path); // reject traversal even though git also scopes to the tree

  let buf: Buffer;
  let oid: string;
  if (ref === WORKTREE) {
    // Live editor: read the on-disk file (reflects unsaved-to-git working changes).
    try {
      buf = await readFile(abs);
    } catch {
      throw notFound(`file not found: ${path}`);
    }
    // Best-effort content hash for ETag/identity; empty if git can't hash it.
    oid = (await git(repoPath, ["rev-parse", `:${path}`]).catch(() => "")).trim();
  } else {
    const spec = `${ref}:${path}`;
    try {
      oid = (await git(repoPath, ["rev-parse", "--verify", "--quiet", spec])).trim();
    } catch {
      throw notFound(`blob not found: ${path} @ ${ref}`);
    }
    buf = await gitBuffer(repoPath, ["cat-file", "blob", oid]);
  }

  const binary = isBinary(buf);
  return {
    path,
    ref,
    oid,
    size: buf.length,
    binary,
    encoding: binary ? "base64" : "utf-8",
    content: binary ? buf.toString("base64") : buf.toString("utf-8"),
  };
}

export async function log(
  repoPath: string,
  ref: string,
  path: string | undefined,
  limit: number,
): Promise<CommitSummary[]> {
  const sep = "\x1f";
  const fmt = ["%H", "%h", "%s", "%an", "%ae", "%aI"].join(sep);
  const args = ["log", `--max-count=${Math.max(1, Math.min(limit || 50, 500))}`, `--format=${fmt}`,
    ref === WORKTREE ? "HEAD" : ref];
  if (path) args.push("--", path);
  const out = await git(repoPath, args);
  return splitLines(out).map((line) => {
    const [oid, shortOid, subject, author, authorEmail, date] = line.split(sep);
    return { oid: oid!, shortOid: shortOid!, subject: subject ?? "", author: author ?? "",
      authorEmail: authorEmail ?? "", date: date ?? "" };
  });
}

export async function diff(
  repoPath: string,
  kind: DiffKind,
  ref: string,
  path: string | undefined,
): Promise<string> {
  const pathArgs = path ? ["--", path] : [];
  if (kind === "worktree") return git(repoPath, ["diff", ...pathArgs]);
  if (kind === "staged") return git(repoPath, ["diff", "--cached", ...pathArgs]);
  // kind === "commit": diff a commit against its first parent.
  const resolved = await resolveRef(repoPath, ref);
  return git(repoPath, ["show", "--format=", resolved, ...pathArgs]);
}

export async function blame(repoPath: string, ref: string, path: string): Promise<string> {
  await confine(repoPath, path);
  const args = ["blame", "--line-porcelain"];
  if (ref !== WORKTREE) args.push(ref);
  args.push("--", path);
  return git(repoPath, args);
}

export async function show(repoPath: string, ref: string): Promise<string> {
  const resolved = await resolveRef(repoPath, ref);
  return git(repoPath, ["show", "--stat", "--patch", resolved]);
}

export async function status(repoPath: string): Promise<StatusEntry[]> {
  const out = await git(repoPath, ["status", "--porcelain=v1", "-z"]);
  const entries: StatusEntry[] = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const index = rec[0] ?? " ";
    const worktree = rec[1] ?? " ";
    const path = rec.slice(3);
    entries.push({ path, index, worktree });
  }
  return entries;
}

function splitLines(s: string): string[] {
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Heuristic: a NUL byte in the first 8 KiB means binary (matches git's own diff heuristic). */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
