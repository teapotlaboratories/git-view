import chokidar, { type FSWatcher } from "chokidar";
import { relative, sep } from "node:path";
import type { RepoConfig } from "../config.js";

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
  private watchers: FSWatcher[] = [];
  private pending = new Map<string, Set<string>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(
    private readonly repos: RepoConfig[],
    private readonly onChanged: (repoId: string, paths: string[]) => void,
    private readonly debounceMs = 250,
  ) {}

  start(): void {
    for (const repo of this.repos) {
      const w = chokidar.watch(repo.path, {
        ignoreInitial: true,
        ignored: (p: string) => this.isIgnored(repo.path, p),
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      });
      w.on("all", (_event, changed) => this.record(repo.id, repo.path, changed));
      w.on("error", () => {}); // transient fs errors (perms, races) must not crash the bridge
      this.watchers.push(w);
    }
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
    this.timers.set(repoId, setTimeout(() => this.flush(repoId), this.debounceMs));
  }

  private flush(repoId: string): void {
    this.timers.delete(repoId);
    const set = this.pending.get(repoId);
    this.pending.delete(repoId);
    if (this.closed || !set || set.size === 0) return;
    this.onChanged(repoId, [...set].slice(0, MAX_PATHS));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
    await Promise.all(this.watchers.map((w) => w.close().catch(() => {})));
    this.watchers = [];
  }
}
