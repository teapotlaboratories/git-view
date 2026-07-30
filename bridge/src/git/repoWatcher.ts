import watcher, { type AsyncSubscription } from "@parcel/watcher";
import { join, relative, sep } from "node:path";
import type { RepoConfig } from "../config.js";
import { git } from "./gitService.js";

/** Guard against a pathological or looping submodule graph while walking gitlinks. */
const MAX_SUBMODULE_DEPTH = 4;

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
 * dir, `node_modules`, and everything the repo's own `.gitignore` excludes. Bursts (a git operation, a
 * multi-file save) are coalesced by a short debounce into a single [onChanged] per repo.
 *
 * **Why @parcel/watcher and not chokidar.** inotify has no recursive watch, so something must watch every
 * directory — but chokidar 4 watches every *path*, files included. Measured on this dev box: four repos
 * came to 180,210 paths against a kernel limit of 119,664, so the bridge consumed **every watch on the
 * machine** and then failed to add more. The symptom was not an error: chokidar's `watch()` threw ENOSPC
 * internally, the bridge kept running, and file changes silently stopped being reported — while any other
 * program wanting a watcher (editors, build tools) also began failing.
 *
 * A directory watch already reports create/modify/delete for the files inside it, so per-file watches buy
 * nothing. @parcel/watcher — the same library VS Code uses — watches directories only: the same four
 * repos need 25,014 watches, and 10,879 once ignored directories are pruned. Node's own
 * `fs.watch(recursive: true)` is not an alternative; it was measured at one watch per path too.
 */
export class RepoWatcher {
  private watchers = new Map<string, AsyncSubscription>();
  private roots = new Map<string, string>(); // repoId -> abs path, for gitignore filtering on flush
  private submodules = new Map<string, string[]>(); // repo root -> submodule prefixes (see submodulePrefixes)
  private pending = new Map<string, Set<string>>();
  /** Repo ids whose subscription is in flight — see watch(). */
  private pendingWatch = new Set<string>();
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

  /**
   * Attach a watcher for one repo at runtime (used when a workspace is opened after boot).
   *
   * Subscribing is async (the native watcher walks the tree), so this returns immediately and the
   * subscription lands later. The id is reserved synchronously via `pendingWatch` so two rapid calls
   * cannot both start a subscription for the same repo — the second would leak the first.
   */
  watch(repo: RepoConfig): void {
    if (this.closed) return;
    if (this.watchers.has(repo.id) || this.pendingWatch.has(repo.id)) return; // double watch() is a no-op
    this.pendingWatch.add(repo.id);
    this.roots.set(repo.id, repo.path);
    void this.subscribe(repo).finally(() => this.pendingWatch.delete(repo.id));
  }

  private async subscribe(repo: RepoConfig): Promise<void> {
    let sub: AsyncSubscription;
    try {
      sub = await watcher.subscribe(
        repo.path,
        (err, events) => {
          if (err) return; // transient fs errors (perms, races) must not crash the bridge
          for (const e of events) this.record(repo.id, repo.path, e.path);
        },
        { ignore: await this.watchIgnores(repo.path) },
      );
    } catch (err) {
      // A repo that cannot be watched must not take the bridge down: it still serves over HTTP, it just
      // does not push changes. But it must not be SILENT either — an unwatchable repo looks exactly like
      // one whose initial walk is still running (a 237k-path repo takes a couple of minutes), and the
      // difference is invisible without this line. Diagnosed the hard way while verifying quartz.
      console.error(`  Watch failed for ${repo.id} (${repo.path}) — changes will not be pushed for it:`,
        (err as Error).message);
      return;
    }
    // close() may have been called while we were subscribing; do not leave an orphan behind.
    if (this.closed || !this.roots.has(repo.id)) {
      await sub.unsubscribe().catch(() => {});
      return;
    }
    this.watchers.set(repo.id, sub);
  }

  /**
   * Directories to skip at *watch* time, as opposed to filtering their events afterwards.
   *
   * This is the difference between fitting in the machine's watch budget and exhausting it: on one ESP32
   * workspace here, git's own ignore list prunes 103,850 of 144,595 paths. Asking git rather than
   * hardcoding `build/`, `.pio/`, `target/`… means the list is exactly what the repo already declares
   * uninteresting — and exactly what `dropIgnored` would discard at flush time anyway, so nothing that
   * could have been reported is lost.
   *
   * Two known limits, both preferred to the alternative of guessing:
   *  - It is a snapshot. A directory first ignored *after* this call (a build dir created later) stays
   *    watched until the repo is re-watched. It costs watches, not correctness.
   *  - `git ls-files` does not descend into submodules, so a submodule's own ignored build output is not
   *    pruned. Same failure mode as `git check-ignore` refusing submodule paths, which is why the flush
   *    filter had to learn about submodules separately.
   */
  private async watchIgnores(root: string): Promise<string[]> {
    const always = ["**/node_modules/**", "**/.git/objects/**", "**/.git/logs/**", "**/.gitview/**"];
    try {
      const out = await git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]);
      const dirs = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.endsWith("/")) // git marks directories with a trailing slash; files are not worth a rule
        .map((d) => `${d.replace(/\/$/, "")}/**`);
      return [...always, ...dirs];
    } catch {
      return always; // not a git repo yet, or git unavailable — the static list still saves the worst of it
    }
  }

  /**
   * Detach the watcher for one repo (used when a workspace is removed). Idempotent.
   *
   * Dropping `roots` FIRST is what makes this safe against an in-flight `watch()`. Subscribing is async
   * and takes as long as the initial walk — around two minutes on a 237k-path repo — and this used to
   * return early when no subscription had landed yet, leaving `roots` populated. The pending
   * `subscribe()` then saw its id still registered and installed the watcher that had just been removed:
   * an orphan nothing could reach, since both `unwatch()` and `close()` iterate `watchers`. A watch leak
   * inside the change that exists to stop watch exhaustion.
   */
  async unwatch(id: string): Promise<void> {
    const root = this.roots.get(id);
    this.roots.delete(id); // the teardown signal an in-flight subscribe() checks before registering
    const w = this.watchers.get(id);
    if (!w) {
      this.cleanupState(id, root);
      return;
    }
    await w.unsubscribe().catch(() => {});
    this.watchers.delete(id);
    this.cleanupState(id, root);
  }

  /** Per-repo bookkeeping dropped on unwatch, whether or not a subscription had landed. */
  private cleanupState(id: string, root: string | undefined): void {
    // Drop the cached submodule list with the repo, or it outlives every workspace ever opened — and a
    // repo re-opened at the same path would be served the OLD list. Keyed by root, so only evict once
    // no remaining repo is watching that root.
    if (root && ![...this.roots.values()].includes(root)) this.submodules.delete(root);
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
    // The same rule applies to a SUBMODULE's git dir (vendor/x/.git/…), not just the top-level one:
    // parts[0] is "vendor" there, so a top-level-only check never matched it and every bit of that
    // submodule's internal churn — above all the index.lock git takes while merely SERVING a diff —
    // reached the client and drove a once-a-second refresh loop.
    const g = parts.indexOf(".git");
    if (g !== -1) {
      // Descend INTO .git (so its children are visible) but keep only the git-state signals —
      // HEAD, index, refs/** — ignoring objects, logs, and *.lock churn. A submodule checking out a
      // new commit still surfaces via its own HEAD/refs, and via the superproject's .git/index.
      const tail = parts.slice(g + 1);
      return !(tail.length === 0 || tail[0] === "HEAD" || tail[0] === "index" || tail[0] === "refs");
    }
    return false;
  }

  private record(repoId: string, root: string, changed: string): void {
    if (this.closed) return;
    // The event filter lives HERE, not in the watcher's ignore list. Those are different jobs: the ignore
    // list is coarse and exists to avoid *watching* huge trees, while this expresses the fine-grained rule
    // the ignore list cannot — descend into `.git` but keep only HEAD, index and refs/**. Chokidar's
    // `ignored` callback happened to do both, so moving to a watcher with glob-only ignores dropped the
    // filtering silently: `.git` churn started reaching clients again and two tests caught it.
    if (this.isIgnored(root, changed)) return;
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

  /**
   * Remove paths git would ignore. On any check-ignore error, keep everything (never suppress a real change).
   *
   * Paths are PARTITIONED BY OWNING REPO first, because `git check-ignore` refuses a path that lives in a
   * submodule — `fatal: Pathspec 'vendor/x/f' is in submodule 'vendor/x'`, exit 128. Since a failure here
   * fails open, one submodule path used to disable filtering for the ENTIRE batch, which quietly undid this
   * whole feature on any repo with submodules. Running check-ignore inside each submodule also means a
   * submodule's own .gitignore finally applies; before, its build output could not be filtered at all.
   */
  private async dropIgnored(root: string, paths: string[]): Promise<string[]> {
    const subs = await this.submodulePrefixes(root);
    // Group by the repo that owns each path: "" = the superproject, else the submodule prefix.
    const groups = new Map<string, string[]>();
    for (const p of paths) {
      const owner = subs.find((s) => p === s || p.startsWith(`${s}/`)) ?? "";
      const list = groups.get(owner);
      if (list) list.push(p);
      else groups.set(owner, [p]);
    }

    const ignored = new Set<string>();
    for (const [owner, group] of groups) {
      // check-ignore wants paths relative to the repo it runs in, and reports them the same way.
      const rels = owner === "" ? group : group.map((p) => p.slice(owner.length + 1));
      const cwd = owner === "" ? root : join(root, owner);
      // exit 0 = at least one ignored; exit 1 = none (git() throws) — both are normal. Anything else
      // (a broken repo, a vanished submodule) also lands here and leaves this group unfiltered.
      const out = await git(cwd, ["check-ignore", "--", ...rels]).catch(() => "");
      for (const line of out.split("\n")) {
        const rel = line.trim();
        if (rel) ignored.add(owner === "" ? rel : `${owner}/${rel}`);
      }
    }
    return paths.filter((p) => !ignored.has(p));
  }

  /**
   * Submodule paths for a repo, relative to its root, longest-first so a nested submodule wins over its
   * parent — ownership lookup takes the first match, so a nested submodule must be tried before its parent.
   *
   * Cached because this costs one `ls-files` spawn per submodule: measured on an aarch64 box against rimba
   * (28 submodules) at ~2s total, versus 12ms for the top level alone. That is paid once per repo, inside
   * an already-debounced flush, so it delays only the FIRST repo.changed after boot.
   *
   * The cache has no invalidation: a submodule ADDED to a repo while it is being watched is not picked up
   * until the repo is re-opened or the bridge restarts. Until then that batch simply fails open, i.e. it
   * behaves as it did before this filtering existed — degraded, not wrong.
   */
  private async submodulePrefixes(root: string): Promise<string[]> {
    const cached = this.submodules.get(root);
    if (cached) return cached;
    // Enumerated with `ls-files --stage` (gitlinks are mode 160000) rather than `git submodule`, which is
    // not on the read allowlist and would also admit its writing subcommands. Recurses, because a nested
    // submodule must win over its parent — esp-idf alone contains 23.
    const prefixes: string[] = [];
    const walk = async (base: string, depth: number): Promise<void> => {
      if (depth > MAX_SUBMODULE_DEPTH) return;
      const out = await git(base ? join(root, base) : root, ["ls-files", "--stage", "-z"]).catch(() => "");
      for (const entry of out.split("\0")) {
        if (!entry.startsWith("160000 ")) continue; // gitlink
        const rel = entry.slice(entry.indexOf("\t") + 1);
        if (!rel) continue;
        const full = base ? `${base}/${rel}` : rel;
        prefixes.push(full);
        await walk(full, depth + 1);
      }
    };
    await walk("", 0);
    prefixes.sort((a, b) => b.length - a.length); // longest first: nested beats parent
    this.submodules.set(root, prefixes);
    return prefixes;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
    await Promise.all([...this.watchers.values()].map((w) => w.unsubscribe().catch(() => {})));
    this.watchers.clear();
    this.roots.clear(); // also tells an in-flight subscribe() to tear itself down rather than register
  }
}
