import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { gitError, notFound, tooLarge } from "../util/errors.js";
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
  "rev-list",
  "ls-tree",
  "cat-file",
  "log",
  "for-each-ref",
  "symbolic-ref",
  "ls-files",
  "diff",
  "diff-index",
  "blame",
  "show",
  "status",
  "check-ignore",
]);

const WRITE_SUBCOMMANDS = new Set(["init", "add", "commit", "restore", "mv", "rm", "checkout", "push"]);

/**
 * Names never exposed through the working-tree browse, regardless of .gitignore: `.git` (the repo
 * database) and `.gitview` (the bridge's own token file + audit log). See docs/SECURITY.md.
 */
const ALWAYS_HIDDEN = new Set([".git", ".gitview"]);

const MAX_BUFFER = 64 * 1024 * 1024;

// Throwaway index files (see the worktree diff) live in one lazily-created 0700 temp dir, so the index
// metadata (paths + oids) isn't readable by other users of a shared /tmp. Unique suffix per call.
let tmpIndexSeq = 0;
let tmpIndexDir: string | undefined;
async function throwawayIndexPath(): Promise<string> {
  if (!tmpIndexDir) tmpIndexDir = await mkdtemp(join(tmpdir(), "gitview-idx-"));
  return join(tmpIndexDir, String(tmpIndexSeq++));
}

export const WORKTREE = "WORKTREE";

/** Run git in string mode (utf-8 output). Enforces the subcommand allowlist. `env` extends process.env
 * (used to point GIT_INDEX_FILE at a throwaway index so a diff doesn't mutate the real one). */
export async function git(repoPath: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  assertAllowed(args[0]);
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
      encoding: "utf-8",
      maxBuffer: MAX_BUFFER,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return stdout;
  } catch (err) {
    throw gitError(cleanGitMessage(err));
  }
}

/** Run git in binary mode (Buffer output) — REQUIRED for blobs so images/binaries aren't corrupted. */
export async function gitBuffer(repoPath: string, args: string[], maxBuffer = MAX_BUFFER): Promise<Buffer> {
  assertAllowed(args[0]);
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
      encoding: "buffer",
      maxBuffer,
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

/** List a working-tree directory from disk (includes untracked files; hides .git/.gitview + ignored). */
async function listWorktree(repoPath: string, path: string): Promise<TreeResponse> {
  const dir = await confine(repoPath, path || ".");
  // Don't list INSIDE a hidden/ignored directory (e.g. .git, .gitview, node_modules) — otherwise the
  // listing leaks its structure (git internals, the token filename) even though blobs stay protected.
  if (path && (await isHiddenOrIgnored(repoPath, path))) throw notFound(`directory not found: ${path}`);
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    throw notFound(`directory not found: ${path || "/"}`);
  }
  // Hide `.git`/`.gitview` unconditionally, then drop anything excluded by .gitignore so the browse
  // API can't serve node_modules, build output, or — critically — the bridge's own secrets.
  const visible = dirents.filter((d) => !ALWAYS_HIDDEN.has(d.name));
  const rels = visible.map((d) => (path ? `${path}/${d.name}` : d.name));
  const ignored = await ignoredPaths(repoPath, rels);

  const entries: TreeEntry[] = [];
  for (const d of visible) {
    const rel = path ? `${path}/${d.name}` : d.name;
    if (ignored.has(rel)) continue;
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

/** Which of the given repo-relative paths .gitignore excludes (batched via `git check-ignore`). */
async function ignoredPaths(repoPath: string, rels: string[]): Promise<Set<string>> {
  if (rels.length === 0) return new Set();
  try {
    // check-ignore echoes back each input path that .gitignore excludes (one per line). quotepath=false
    // keeps paths raw so they match the inputs exactly. (`-z` is only valid with `--stdin`.)
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "-c", "core.quotepath=false", "check-ignore", "--", ...rels],
      { encoding: "utf-8", maxBuffer: MAX_BUFFER },
    );
    return new Set((stdout as string).split("\n").filter((s) => s.length > 0));
  } catch {
    // Exits non-zero when none match; ALWAYS_HIDDEN still covers the secrets either way.
    return new Set();
  }
}

/** True if a working-tree path is hidden (`.git`/`.gitview` segment) or excluded by .gitignore. */
async function isHiddenOrIgnored(repoPath: string, rel: string): Promise<boolean> {
  if (rel.split("/").some((seg) => ALWAYS_HIDDEN.has(seg))) return true;
  return (await ignoredPaths(repoPath, [rel])).has(rel);
}

/**
 * Largest committed blob we will read into memory.
 *
 * `gitBuffer`'s general `MAX_BUFFER` is 64 MB, which every file this bridge had been asked for fits
 * inside — and which a **KiCad board** does not. `vme-wren.kicad_pcb` is 66.4 MB, so the board endpoint
 * failed at any committed ref with `git_error: stdout maxBuffer length exceeded`: a message naming an
 * internal buffer rather than the file, returned as 422 rather than a size error. The working tree
 * happened to work, because that path reads from disk. Found by curling the endpoint; no test had a file
 * big enough to notice.
 *
 * So blobs get their own ceiling, sized for the artefacts this product exists to open, and it is checked
 * *before* reading so exceeding it is a clear 413 naming the file and both numbers.
 */
const MAX_BLOB_BYTES = 192 * 1024 * 1024;

/**
 * Read one committed blob, refusing up front if it is bigger than we are willing to hold.
 *
 * `cat-file -s` costs one cheap process and turns "mystery buffer error after reading 64 MB" into a
 * decision made before any bytes move.
 */
async function readBlobBytes(repoPath: string, oid: string, path: string, ref: string): Promise<Buffer> {
  const size = Number((await git(repoPath, ["cat-file", "-s", oid]).catch(() => "")).trim());
  if (Number.isFinite(size) && size > MAX_BLOB_BYTES) {
    throw tooLarge(
      `${path} @ ${ref} is ${Math.round(size / 1048576)} MB, over the ${Math.round(MAX_BLOB_BYTES / 1048576)} MB blob limit`,
    );
  }
  // Give the child a ceiling that fits the blob we just measured, plus slack; fall back to the hard cap
  // when `cat-file -s` could not tell us, so a broken repo still fails as a git error rather than here.
  const ceiling = Number.isFinite(size) && size > 0 ? Math.min(size * 2 + 1024, MAX_BLOB_BYTES) : MAX_BLOB_BYTES;
  return gitBuffer(repoPath, ["cat-file", "blob", oid], ceiling);
}

export async function readBlob(repoPath: string, ref: string, path: string): Promise<BlobResponse> {
  const abs = await confine(repoPath, path); // reject traversal even though git also scopes to the tree

  let buf: Buffer;
  let oid: string;
  if (ref === WORKTREE) {
    // Never serve hidden/ignored working-tree files (e.g. .gitview/tokens.json) — 404 without leaking.
    if (await isHiddenOrIgnored(repoPath, path)) throw notFound(`file not found: ${path}`);
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
    buf = await readBlobBytes(repoPath, oid, path, ref);
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
  // `--shortstat` appends a " N files changed, X insertions(+), Y deletions(-)" line after each commit;
  // a header line (has the \x1f field separator) starts a commit, a stat line updates the last one.
  const args = ["log", `--max-count=${Math.max(1, Math.min(limit || 50, 500))}`, `--format=${fmt}`,
    "--shortstat", ref === WORKTREE ? "HEAD" : ref];
  if (path) args.push("--", path);
  const out = await git(repoPath, args);
  const commits: CommitSummary[] = [];
  for (const line of out.split("\n")) {
    if (line.includes(sep)) {
      const [oid, shortOid, subject, author, authorEmail, date] = line.split(sep);
      commits.push({ oid: oid!, shortOid: shortOid!, subject: subject ?? "", author: author ?? "",
        authorEmail: authorEmail ?? "", date: date ?? "", files: 0, additions: 0, deletions: 0 });
    } else if (commits.length && /changed/.test(line)) {
      const c = commits[commits.length - 1]!;
      c.files = matchNum(line, /(\d+) files? changed/);
      c.additions = matchNum(line, /(\d+) insertions?\(\+\)/);
      c.deletions = matchNum(line, /(\d+) deletions?\(-\)/);
    }
  }
  return commits;
}

function matchNum(s: string, re: RegExp): number {
  const m = s.match(re);
  return m ? Number(m[1]) : 0;
}

export interface RepoState { branch: string; ahead?: number; behind?: number; dirty: number }

// Each repoState() forks three git subprocesses; GET /v1/repos calls it per repo, so a short TTL cache
// keeps a burst of list requests from stampeding the host. The window is tiny (git-state chips are a
// snapshot, refreshed on the next request), so staleness is not observable in the UI.
const REPO_STATE_TTL_MS = 2000;
const repoStateCache = new Map<string, { at: number; value: RepoState }>();

/**
 * Live git-state for a repo's working tree: current branch, ahead/behind vs its upstream (undefined
 * when there's no upstream), and the count of dirty (modified/staged/untracked) entries.
 */
export async function repoState(repoPath: string): Promise<RepoState> {
  const cached = repoStateCache.get(repoPath);
  if (cached && Date.now() - cached.at < REPO_STATE_TTL_MS) return cached.value;

  const [branchRaw, porcelain, ab] = await Promise.all([
    // symbolic-ref covers an UNBORN branch (fresh repo, no commit) where rev-parse --abbrev-ref fails.
    git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])
      .catch(() => git(repoPath, ["symbolic-ref", "--short", "HEAD"]))
      .catch(() => "HEAD"),
    git(repoPath, ["status", "--porcelain"]).catch(() => ""),
    // `rev-list --left-right --count @{upstream}...HEAD` → "<behind>\t<ahead>"; errors with no upstream.
    git(repoPath, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]).catch(() => null),
  ]);
  const branch = branchRaw.trim();
  const dirty = porcelain.split("\n").filter((l) => l.trim().length > 0).length;
  let ahead: number | undefined;
  let behind: number | undefined;
  if (ab) {
    const [b, a] = ab.trim().split(/\s+/).map(Number);
    if (Number.isFinite(b)) behind = b;
    if (Number.isFinite(a)) ahead = a;
  }
  const value: RepoState = { branch, ahead, behind, dirty };
  repoStateCache.set(repoPath, { at: Date.now(), value });
  return value;
}

export async function diff(
  repoPath: string,
  kind: DiffKind,
  ref: string,
  path: string | undefined,
): Promise<string> {
  const pathArgs = path ? ["--", path] : [];
  if (kind === "worktree") {
    // `git diff` ignores untracked files, so a repo whose only changes are brand-new files shows an EMPTY
    // worktree diff even though it counts as "dirty". To include them we mark them intent-to-add (`-N`) so
    // they render as new-file diffs — but against a THROWAWAY copy of the index (GIT_INDEX_FILE), NOT the
    // real one. Touching the real .git/index would trip the repo watcher → repo.changed → the app re-fetches
    // the diff → mutate again → infinite refresh loop. The temp index is discarded, so nothing persists.
    const untracked = (await git(repoPath, ["ls-files", "--others", "--exclude-standard", "-z", ...pathArgs]))
      .split("\0")
      .filter((f) => f.length > 0);
    if (untracked.length === 0) return git(repoPath, ["diff", ...pathArgs]);

    const gitDir = (await git(repoPath, ["rev-parse", "--absolute-git-dir"])).trim();
    const tmpIndex = await throwawayIndexPath();
    // Seed the temp index from the real one so tracked/staged state is preserved (an empty repo may have
    // no index yet — then git creates a fresh empty temp index, which is correct).
    await copyFile(join(gitDir, "index"), tmpIndex).catch(() => {});
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      await git(repoPath, ["add", "-N", "--", ...untracked], env);
      return await git(repoPath, ["diff", ...pathArgs], env);
    } finally {
      await rm(tmpIndex, { force: true }).catch(() => {});
    }
  }
  if (kind === "staged") return git(repoPath, ["diff", "--cached", ...pathArgs]);
  // kind === "commit": diff a commit against its first parent. `-m --first-parent` forces a
  // merge commit to render as a normal 2-way diff (against parent 1) instead of git's default
  // combined (`--cc`) format, whose 2-column line prefixes the client's diff renderer can't read.
  // No effect on non-merge or root commits.
  const resolved = await resolveRef(repoPath, ref);
  return git(repoPath, ["show", "--format=", "-m", "--first-parent", resolved, ...pathArgs]);
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
