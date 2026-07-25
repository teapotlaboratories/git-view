import chokidar, { type FSWatcher } from "chokidar";
import { relative, sep } from "node:path";
import type { RepoConfig } from "../config.js";
import { git } from "./gitService.js";

/** Cap the paths carried in one event — the client re-fetches anyway; this is just a hint. */
const MAX_PATHS = 200;

/**
 * Watches each registered repo's working tree and reports coalesced changes via [onChanged].
 *
 * What it surfaces:
 *  - working-tree file add/change/delete/rename (the main case: the app — or Claude — edited a file);
 *  - a few `.git` entries that signal a *git-state* change the UI cares about — `.git/HEAD` (branch),
 *    `.git/index` (staging), and anything under `.git/refs/**` (commits/branches/tags).
 *
 * What it ignores: the rest of `.git` (objects, logs, lock files — pure churn), the `.gitview` control
 * dir, and `node_modules`. Bursts (a git operation, a multi-file save) are coalesced by chokidar's
 * `awaitWriteFinish` plus a short debounce into a single [onChanged] per repo.
 */
export class RepoWatcher {
  private watchers = new Map<string, FSWatcher>();
  private roots = new Map<string, string>(); // repoId -> abs path, for gitignore filtering on flush
  private pending = new Map<string, Set<string>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(
    private readonly repos: RepoConfig[],
    private readonly onChanged: (repoId: string, paths: string[]) => void,
    private readonly debounceMs = 250,
  ) {}

  start(): void {
    for (const repo of this.repos) this.watch(repo);
  }

  /** Attach a watcher for one repo at runtime (used when a workspace is opened after boot). */
  watch(repo: RepoConfig): void {
    if (this.closed) return;
    if (this.watchers.has(repo.id)) return; // already watching — a double watch() is a no-op
    const w = chokidar.watch(repo.path, {
      ignoreInitial: true,
      ignored: (p: string) => this.isIgnored(repo.path, p),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    w.on("all", (_event, changed) => this.record(repo.id, repo.path, changed));
    w.on("error", () => {}); // transient fs errors (perms, races) must not crash the bridge
    this.watchers.set(repo.id, w);
    this.roots.set(repo.id, repo.path);
  }

  /** Detach the watcher for one repo (used when a workspace is removed). Idempotent. */
  async unwatch(id: string): Promise<void> {
    const w = this.watchers.get(id);
    if (!w) return;
    await w.close().catch(() => {});
    this.watchers.delete(id);
    this.roots.delete(id);
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    this.pending.delete(id);
  }

  /** True for paths the UI never needs a refresh for. `p` is absolute; the root itself is kept. */
  private isIgnored(root: string, p: string): boolean {
    const rel = relative(root, p);
    if (rel.startsWith("..")) return true; // outside the root
    if (rel === "") return false; // the root itself — must be watched
    const parts = rel.split(sep);
    if (parts[0] === ".gitview") return true;
    if (parts.includes("node_modules")) return true;
    if (parts[0] === ".git") {
      // Descend INTO .git (so its children are visible) but keep only the git-state signals —
      // HEAD, index, refs/** — ignoring objects, logs, and *.lock churn.
      return !(rel === ".git" || rel === `.git${sep}HEAD` || rel === `.git${sep}index` || parts[1] === "refs");
    }
    return false;
  }

  private record(repoId: string, root: string, changed: string): void {
    if (this.closed) return;
    const rel = relative(root, changed);
    let set = this.pending.get(repoId);
    if (!set) { set = new Set(); this.pending.set(repoId, set); }
    set.add(rel);
    const existing = this.timers.get(repoId);
    if (existing) clearTimeout(existing);
    this.timers.set(repoId, setTimeout(() => { void this.flush(repoId).catch(() => {}); }, this.debounceMs));
  }

  private async flush(repoId: string): Promise<void> {
    this.timers.delete(repoId);
    const set = this.pending.get(repoId);
    this.pending.delete(repoId);
    if (this.closed || !set || set.size === 0) return;
    const paths = [...set].slice(0, MAX_PATHS);
    // Drop gitignored paths (build outputs, dist/, .gradle/, …). They don't affect the tree or diff the
    // app renders (those use --exclude-standard), so firing repo.changed for them would spam the UI into a
    // pointless refresh loop while a build churns. Keep the git-state signals (.git/HEAD|index|refs) — git
    // doesn't ignore `.git`, so check-ignore leaves them in.
    const root = this.roots.get(repoId);
    const kept = root ? await this.dropIgnored(root, paths) : paths;
    if (this.closed || kept.length === 0) return;
    this.onChanged(repoId, kept);
  }

  /** Remove paths git would ignore. On any check-ignore error, keep everything (never suppress a real change). */
  private async dropIgnored(root: string, paths: string[]): Promise<string[]> {
    // `git check-ignore -- <paths>` prints the ignored inputs (exit 0 if ≥1, exit 1 if none → git() throws;
    // both mean "no error"). Anything unexpected also lands in the catch and we keep all paths.
    const out = await git(root, ["check-ignore", "--", ...paths]).catch(() => "");
    if (!out.trim()) return paths;
    const ignored = new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
    return paths.filter((p) => !ignored.has(p));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
    await Promise.all([...this.watchers.values()].map((w) => w.close().catch(() => {})));
    this.watchers.clear();
  }
}
