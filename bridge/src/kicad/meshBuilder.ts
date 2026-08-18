/**
 * Converting a board's models **on demand** (ADR-040 Decision 5).
 *
 * This reverses ADR-038's deliberately ahead-of-time pipeline, so the bounds are part of the decision
 * rather than an afterthought.
 *
 * **Why reverse it at all.** The measurement that made this necessary: a `${KIPRJMOD}` model is committed
 * in the repo — 24 unique ones in the KiCad 10 corpus, 24 of 24 present — needing no operator mapping, no
 * 5.7 GB library and no download, and *still* nothing renders, because conversion was a CLI somebody had
 * to log in and run. On-demand is the only version of this that works for a person who just opened a
 * board.
 *
 * **The bridge still never loads a CAD kernel.** That rule is about this process, and spawning is how it
 * stays true: the converter is a separate program with its own 7.3 MB of OCCT WASM, and the bridge only
 * ever reads what it leaves behind. Measured reasons not to inline it — 0.37 s for a library part, 6.4 s
 * for a TQFP-100, **101.7 s and 1.7 GB of RSS** for a 25 MB vendor model. None of that may happen on a
 * request thread.
 *
 * ## What bounds the work
 *
 * - **One build per board, ever concurrent.** Keyed by repo + board — deliberately *not* the ref; see
 *   [keyOf], because the converter reads the working tree and a ref-keyed build would promise something
 *   no layer below it delivers.
 * - **A global cap**, because the converter is CPU- and memory-hungry and a bridge is often somebody's
 *   spare machine. Boards queue rather than pile up, and the queue itself has a ceiling.
 * - **A cooldown per board**, so a board that is opened, closed and reopened does not respawn a build
 *   that just finished with nothing left to do.
 * - **Only when something is actually pending** — see [pendingModels]. Counting instead of naming made
 *   this respawn forever on any board holding a model that resolves but cannot be converted.
 * - **The request never waits.** Opening a board returns immediately with whatever is already converted;
 *   the build fills the cache and the next refresh sees more. A viewer that blocks for 101 s is worse
 *   than one that fills in.
 *
 * Concurrency *within* the cache was already solved: blobs are content-addressed and written through a
 * temp file plus `rename`, so two converters producing the same bytes race to the same filename and the
 * loser's work is discarded rather than corrupting anything.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModel, type ResolveOptions } from "./modelResolve.js";
import { embeddedName } from "./board.js";

/** How many converters may run at once. */
const MAX_CONCURRENT = 1;

/**
 * How long after a build finishes before the same board may trigger another.
 *
 * Long enough that opening, closing and reopening a board does not respawn a build that just found
 * nothing to do — a full pass over an already-converted board still costs a parse and a hash per model.
 */
const COOLDOWN_MS = 60_000;

/** How long a `SIGTERM`ed converter has to flush before it is killed outright. */
const KILL_GRACE_MS = 10_000;

/** Wall-clock ceiling for one board. A 66-model board with a 25 MB vendor part is minutes, not hours. */
const BUILD_TIMEOUT_MS = 15 * 60_000;

/**
 * How many boards may wait behind the running one.
 *
 * The queue is reachable from an authenticated client simply by opening boards, so it needs a ceiling
 * like any other request-driven buffer: without one, walking a repo's boards enqueues work faster than a
 * single converter drains it, and each entry pins a promise and eventually spawns a process. Refusing is
 * the honest answer — the client is told `busy` and can ask again.
 */
const MAX_QUEUED = 8;

/** How many finished-board timestamps to remember, so the cooldown map cannot grow unboundedly. */
const MAX_REMEMBERED = 256;

/**
 * How many (board, fingerprint) attempts to remember.
 *
 * Bounded like [MAX_REMEMBERED] and for the same reason: one entry per board per distinct pending set
 * would otherwise accumulate for the life of the process.
 */
const MAX_ATTEMPTS_REMEMBERED = 512;

/**
 * How many times identical work may FAIL before it is left alone.
 *
 * Separate from the attempt rule, and the distinction is the whole of it: a build that exits cleanly has
 * told us what this work amounts to, so repeating it is pointless. A build that was *killed* has told us
 * nothing — the OOM killer at a 1.7 GB peak, or the wall-clock timeout on a genuinely large board, are
 * facts about the machine that day, not about the models. Treating those the same way settled boards
 * permanently and unrecoverably: even deleting the mesh cache does not help, because a cold cache
 * reproduces exactly the pending set that produced the fingerprint.
 *
 * So failures get a few goes, and only then stop.
 */
const MAX_FAILED_ATTEMPTS = 3;

/** Size cap handed to the converter, in MB. Passed explicitly — see [spawnBuild]. */
const MAX_MODEL_MB = 32;

export interface BuildRequest {
  /** Absolute path of the repository working tree. */
  repoPath: string;
  /** Stable repo id — part of the manifest's identity, so it must match what the reader uses. */
  repoId: string;
  /** Repo-relative path of the `.kicad_pcb`. */
  boardPath: string;
  /** Mesh cache directory. */
  cacheDir: string;
  /** Variable → directory mapping for library models. */
  modelPaths: Readonly<Record<string, string>>;
}

export type BuildState =
  /** A converter is running for this board right now. */
  | { status: "running" }
  /** Queued behind the concurrency cap. */
  | { status: "queued" }
  /** Not started: too soon after the last one. */
  | { status: "cooling" }
  /** The queue is full. Nothing was started; asking again later is the right move. */
  | { status: "busy" }
  /**
   * This exact work was already attempted, so it is not repeated.
   *
   * Not a failure and not terminal: the moment anything that would change the outcome changes — a
   * mapped variable, an installed library, an edited board — the pending set differs, and that is a new
   * attempt. Reported rather than left silent because it is the honest answer to "why is nothing
   * building", and it is the state that tells an operator the converter got nowhere last time.
   */
  | { status: "settled" }
  /** This bridge has no converter to spawn — the normal state of a bridge that never installed one. */
  | { status: "unavailable"; reason: string };

interface Entry {
  promise: Promise<void>;
  /** Whether this one has actually been let through the concurrency gate. */
  queued: boolean;
}

const inflight = new Map<string, Entry>();
const finishedAt = new Map<string, number>();
/**
 * (board, fingerprint) pairs that have already been built once.
 *
 * This is the whole retry rule, and it is stated positively — *build once for each distinct state of the
 * work* — rather than negatively as "keep building while something is pending". The negative form was
 * unsound and produced three separate infinite loops before this, one per way the converter can fail to
 * record progress; every new failure mode had to be discovered and patched individually. Counting
 * futile attempts as a backstop then produced the mirror bug: three ordinary refreshes of a
 * fully-converted board drove the counter to its limit with no build in between, and the next model the
 * user added was never converted.
 *
 * With this rule none of those are reachable. A build that dies before writing anything simply never
 * repeats, because nothing about the work changed. And recovery is automatic rather than a special case:
 * mapping a variable, installing a library, or editing the board all change the pending set, which
 * changes the fingerprint, which is a new attempt.
 */
const attempted = new Set<string>();

/** Failure counts for work that did not exit cleanly — see [MAX_FAILED_ATTEMPTS]. */
const failures = new Map<string, number>();
let running = 0;
const queue: Array<() => void> = [];

/**
 * The identity of a build.
 *
 * **The ref is deliberately not part of this**, which is not an oversight: the converter reads the
 * *working tree* (`readFileSync(join(repo, board))`) and writes a manifest keyed by repo + board alone.
 * Including the ref would therefore promise something no layer below delivers — browsing one board at
 * five commits would spawn five identical builds that neither the in-flight join nor the cooldown could
 * suppress, each serialized behind the cap, and every one of them would overwrite the same manifest with
 * the working tree's answer.
 *
 * When models are read as git blobs at the requested ref — the open item in `docs/PLAN.md` — the ref
 * becomes a real part of a build's identity and belongs here. It does not yet.
 */
const keyOf = (r: BuildRequest): string => JSON.stringify([r.repoId, r.boardPath]);

/**
 * Where the converter lives, when it does.
 *
 * Probed rather than required. The `.deb` ships one at `/opt/gitview-bridge/models/cli.js`, which is the
 * first candidate; a bridge running from a checkout finds the compiled tree instead; and one with neither
 * lands in `unavailable` and simply serves whatever the cache already holds, which is a normal state
 * rather than a misconfiguration. An explicit `kicad.converter` always wins.
 *
 * The dev-tree paths are last and are checked for existence, so a production bridge cannot accidentally
 * resolve a path that only makes sense in a checkout.
 */
export function findConverter(configured: string): string | undefined {
  // A FILE, not merely something at that path. `existsSync` alone accepted a directory — a realistic
  // typo, and one that reports `running` forever because node exits non-zero on it every time rather
  // than degrading to "this bridge cannot convert".
  if (configured) return isFile(configured) ? configured : undefined;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Packaged: beside the bridge's own dist, which is where the `.deb` puts it. `here` is
    // `/opt/gitview-bridge/dist/kicad`, so two levels up is the package root.
    //
    // This used to be three levels up, which resolved to `/opt/models/cli.js` — outside the package
    // entirely, and equally wrong in a checkout. It had never found anything, which nothing noticed
    // because no build shipped a converter for it to find.
    resolve(here, "../../models/cli.js"),
    // An operator who put it somewhere standard by hand.
    "/usr/lib/gitview-bridge/models/cli.js",
    // A checkout, compiled.
    resolve(here, "../../../tools/gitview-models/dist/tools/gitview-models/src/cli.js"),
  ];
  return candidates.find(isFile);
}

/** Is there a regular file at this path? */
function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Reset between tests. */
export function resetBuilder(): void {
  inflight.clear();
  finishedAt.clear();
  attempted.clear();
  failures.clear();
  queue.length = 0;
  running = 0;
}



/** How many builds are running or queued — for tests and for reporting. */
export const builderDepth = (): number => inflight.size;

function runNext(): void {
  if (running >= MAX_CONCURRENT) return;
  const next = queue.shift();
  if (!next) return;
  running += 1;
  next();
}

/**
 * Spawn the converter for one board, unless one is already running, queued, or just finished.
 *
 * Returns immediately — the caller is a request that must not wait. `spawnBuild` is deliberately not
 * awaited anywhere on the request path; the state it returns is a *hint* for the client ("something is
 * being built, ask again"), not a result.
 */
/**
 * How a child is started. Injectable for one reason only, and it is a good one.
 *
 * The failure this guards against — Node emitting **both** `error` and `close`, so a naive handler
 * settles twice — happens when the *spawn* fails: EAGAIN or EMFILE on a loaded machine. It cannot be
 * provoked by pointing at a converter that is not there, because what gets spawned is
 * `process.execPath`, and node always exists; a missing script just makes node exit 1 and only `close`
 * fires. Discovered by breaking the guard on purpose and watching nothing fail.
 *
 * So the seam exists to make a real, reachable failure reachable *from a test*, rather than leaving the
 * fix pinned by an assertion that cannot fail.
 */
export type Spawner = (cmd: string, args: string[]) => {
  once(ev: "error" | "close", cb: (code?: number | null) => void): unknown;
  kill(sig: "SIGKILL" | "SIGTERM"): unknown;
};

const defaultSpawner: Spawner = (cmd, args) => spawn(cmd, args, { stdio: "ignore", detached: false });

export function spawnBuild(
  req: BuildRequest,
  converter: string | undefined,
  /**
   * The models this build would try to convert, from [pendingModels].
   *
   * Part of the identity of an attempt: two requests naming the same pending set would run the same
   * converter over the same inputs and reach the same answer, so the second is pointless.
   */
  pending: readonly string[],
  now = Date.now(),
  spawner: Spawner = defaultSpawner,
): BuildState {
  if (!converter) {
    return { status: "unavailable", reason: "no converter is installed on this bridge" };
  }
  const key = keyOf(req);
  // Report what it is actually doing. Reporting "running" for something still behind the gate told the
  // app a converter was working when nothing had been spawned.
  const existing = inflight.get(key);
  if (existing) return { status: existing.queued ? "queued" : "running" };
  const last = finishedAt.get(key);
  if (last !== undefined && now - last < COOLDOWN_MS) return { status: "cooling" };
  const fp = fingerprint(req, pending);
  // A clean run of exactly this work, or enough failed ones. Both mean another go changes nothing.
  if (attempted.has(fp)) return { status: "settled" };
  if ((failures.get(fp) ?? 0) >= MAX_FAILED_ATTEMPTS) return { status: "settled" };
  if (queue.length >= MAX_QUEUED) return { status: "busy" };

  const start = (): Promise<void> =>
    new Promise<void>((done) => {
      // Exactly once, whatever happens. Node emits **both** `error` and `close` when a spawn fails —
      // verified on this box — so registering `finish` on each ran it twice: `running` was decremented
      // twice and drifted negative, after which `running < MAX_CONCURRENT` is always true and the cap
      // that exists to bound a 1.7 GB-RSS converter is silently gone.
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let killer: NodeJS.Timeout | undefined;
      const finish = (code: number | null | undefined): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killer) clearTimeout(killer);
        inflight.delete(key);
        remember(key);
        // **Only a clean exit settles the work.** Recorded on finish rather than on request — recording
        // per request is what let three refreshes exhaust the old counter with no build in between — but
        // recording it whatever the exit code was just as wrong in the other direction: a converter the
        // OOM killer took writes no manifest, leaves the pending set identical, and would then never be
        // retried for the life of the process. A kill is a fact about the machine, not about the models.
        if (code === 0) {
          rememberAttempt(fp);
          failures.delete(fp);
        } else {
          bumpFailure(fp);
        }
        running -= 1;
        runNext();
        done();
      };

      const args = [
        converter, "build",
        "--repo", req.repoPath,
        "--repo-id", req.repoId,
        "--board", req.boardPath,
        "--cache", req.cacheDir,
        // Passed explicitly rather than relying on the CLI's default happening to match the ceiling this
        // module documents — a silent coupling that breaks the moment either side moves.
        "--max-mb", String(MAX_MODEL_MB),
      ];
      for (const [k, v] of Object.entries(req.modelPaths)) args.push("--model-path", `${k}=${v}`);
      try {
        // `execPath` rather than a bare "node": a bridge started from a versioned Node install must spawn
        // *that* Node, not whatever a login shell would have found — the .deb's own unit does exactly this.
        const child = spawner(process.execPath, args);
        // `SIGTERM` first, then `SIGKILL` if it will not go — and the grace period is only worth
        // anything because `gitview-models` now handles the signal. It writes its manifest in one shot
        // after the last model, so a bare `SIGKILL` on a board that legitimately runs long threw away
        // every blob it had converted: they sit in the content-addressed cache with nothing naming them,
        // so the index reports `ready: 0` and a re-run has to redo the lot. With the handler it flushes
        // what it has, and the next run reuses those blobs in seconds.
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        }, BUILD_TIMEOUT_MS);
        child.once("error", () => finish(undefined));
        child.once("close", (code) => finish(code));
      } catch {
        // A synchronous throw — a NUL byte in a configured path is enough. Without this the stored
        // promise rejects with nobody attached, which is process-fatal under Node's default, and the key
        // would stay in `inflight` with `running` never decremented, so every later build queues forever.
        finish(undefined);
      }
    });

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const entry: Entry = { promise: gate.then(start), queued: running >= MAX_CONCURRENT };
  inflight.set(key, entry);

  if (!entry.queued) {
    running += 1;
    release();
    return { status: "running" };
  }
  queue.push(() => { entry.queued = false; release(); });
  return { status: "queued" };
}

/**
 * What makes two build attempts the same.
 *
 * The pending set and the variable mapping, because those are exactly the inputs that decide what the
 * converter will do. The board path is in there via the key; the board's *bytes* are not needed —
 * editing a board changes which models it references, which changes the pending set.
 */
function fingerprint(req: BuildRequest, pending: readonly string[]): string {
  const vars = Object.entries(req.modelPaths).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify([keyOf(req), [...pending].sort(), vars]))
    .digest("hex");
}

/** Count a failed run of this work, bounded like the attempt set. */
function bumpFailure(fp: string): void {
  failures.set(fp, (failures.get(fp) ?? 0) + 1);
  while (failures.size > MAX_ATTEMPTS_REMEMBERED) {
    const oldest = failures.keys().next();
    if (oldest.done) break;
    failures.delete(oldest.value);
  }
}

/** Remember one attempt, bounded. */
function rememberAttempt(fp: string): void {
  attempted.delete(fp);
  attempted.add(fp);
  while (attempted.size > MAX_ATTEMPTS_REMEMBERED) {
    const oldest = attempted.values().next();
    if (oldest.done) break;
    attempted.delete(oldest.value);
  }
}

/** Record a finish, keeping the cooldown map bounded. */
function remember(key: string): void {
  finishedAt.delete(key);
  finishedAt.set(key, Date.now());
  // Insertion-ordered, so the oldest is the first key. A bridge serving many boards must not accumulate
  // a timestamp per board for the life of the process.
  while (finishedAt.size > MAX_REMEMBERED) {
    const oldest = finishedAt.keys().next();
    if (oldest.done) break;
    finishedAt.delete(oldest.value);
  }
}

/** Await every in-flight build. Tests only — nothing on the request path may wait for a conversion. */
export async function drainBuilds(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight.values()].map((e) => e.promise));
}

export { COOLDOWN_MS, MAX_CONCURRENT };

/**
 * Which of a board's models are worth spawning a converter for.
 *
 * **By name, never by counting.** The first version subtracted `meshes.ready` from
 * `resolved.present + resolved.embedded`, and that is wrong in both directions:
 *
 *  - It never reaches zero for a model that is *found but unconvertible*. A `.wrl` with no STEP twin
 *    resolves as `present` while the manifest records `unsupported-format` and no key, so `ready` never
 *    counts it — `video` sits at 24 resolvable and 23 ready forever. Every index request past the
 *    cooldown then respawned a full converter pass that could not make progress: a permanent background
 *    burn on any board with one project-local `.wrl`, and the corpus has 18.
 *  - It can also read as *nothing to do* when there is. `ready` counts manifest entries, including ones
 *    for models no longer referenced — the hidden models now excluded from the board are exactly that —
 *    so the arithmetic could go to zero while visible models were genuinely unbuilt.
 *
 * A recorded failure suppresses a rebuild only when re-running would get the same answer. `unresolved`
 * does not: an operator who maps a variable or installs the library changes that outcome, and this is
 * evaluated *after* resolution, so a model that now resolves is offered again.
 */
export function pendingModels(
  index: { models: { paths: readonly string[]; embedded: readonly string[] } },
  manifest: { entries: ReadonlyArray<{ raw: string; key?: string; failure?: string }> } | undefined,
  opts: ResolveOptions,
): string[] {
  const ready = new Set((manifest?.entries ?? []).filter((e) => e.key).map((e) => e.raw));
  // Deterministic for the same bytes — re-running the converter would reach the same conclusion.
  const settled = new Set(
    (manifest?.entries ?? [])
      .filter((e) => !e.key && e.failure && e.failure !== "unresolved")
      .map((e) => e.raw),
  );
  const embedded = new Set(index.models.embedded);
  const withEmbedded = { ...opts, embedded };
  return index.models.paths.filter((raw) => {
    if (ready.has(raw) || settled.has(raw)) return false;
    const name = embeddedName(raw);
    if (name !== undefined) return embedded.has(name);
    return resolveModel(raw, withEmbedded).file !== undefined;
  });
}
