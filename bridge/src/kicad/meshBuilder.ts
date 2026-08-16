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
 * - **One build per board, ever concurrent.** Keyed by repo + board + ref, so two devices opening the
 *   same board share one build rather than racing two.
 * - **A global cap**, because the converter is CPU- and memory-hungry and a bridge is often somebody's
 *   spare machine. Boards queue rather than pile up.
 * - **A cooldown per board**, so a board that is opened, closed and reopened does not respawn a build
 *   that just finished with nothing left to do.
 * - **The request never waits.** Opening a board returns immediately with whatever is already converted;
 *   the build fills the cache and the next refresh sees more. A viewer that blocks for 101 s is worse
 *   than one that fills in.
 *
 * Concurrency *within* the cache was already solved: blobs are content-addressed and written through a
 * temp file plus `rename`, so two converters producing the same bytes race to the same filename and the
 * loser's work is discarded rather than corrupting anything.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** How many converters may run at once. */
const MAX_CONCURRENT = 1;

/**
 * How long after a build finishes before the same board may trigger another.
 *
 * Long enough that opening, closing and reopening a board does not respawn a build that just found
 * nothing to do — a full pass over an already-converted board still costs a parse and a hash per model.
 */
const COOLDOWN_MS = 60_000;

/** Wall-clock ceiling for one board. A 66-model board with a 25 MB vendor part is minutes, not hours. */
const BUILD_TIMEOUT_MS = 15 * 60_000;

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
  /** Ref the board was read at, so a build for an older commit is not confused with one for HEAD. */
  ref: string;
}

export type BuildState =
  /** A converter is running for this board right now. */
  | { status: "running" }
  /** Queued behind the concurrency cap. */
  | { status: "queued" }
  /** Not started: too soon after the last one. */
  | { status: "cooling" }
  /** This bridge has no converter to spawn — the normal state of a bridge that never installed one. */
  | { status: "unavailable"; reason: string };

interface Entry {
  promise: Promise<void>;
  startedAt: number;
}

const inflight = new Map<string, Entry>();
const finishedAt = new Map<string, number>();
let running = 0;
const queue: Array<() => void> = [];

const keyOf = (r: BuildRequest): string => JSON.stringify([r.repoId, r.boardPath, r.ref]);

/**
 * Where the converter lives, when it does.
 *
 * Probed rather than required, because the honest default is that a bridge does not have one: the `.deb`
 * does not ship it yet, so every packaged bridge lands in `unavailable` and simply serves what the cache
 * already holds. An explicit `kicad.converter` always wins.
 *
 * The dev-tree paths are last and are checked for existence, so a production bridge cannot accidentally
 * resolve a path that only makes sense in a checkout.
 */
export function findConverter(configured: string): string | undefined {
  if (configured) return existsSync(configured) ? configured : undefined;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Packaged: beside the bridge's own dist, as the .deb would lay it out.
    "/usr/lib/gitview-bridge/models/cli.js",
    resolve(here, "../../../models/cli.js"),
    // A checkout, compiled.
    resolve(here, "../../../tools/gitview-models/dist/tools/gitview-models/src/cli.js"),
  ];
  return candidates.find((c) => existsSync(c));
}

/** Reset between tests. */
export function resetBuilder(): void {
  inflight.clear();
  finishedAt.clear();
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
export function spawnBuild(req: BuildRequest, converter: string | undefined, now = Date.now()): BuildState {
  if (!converter) {
    return { status: "unavailable", reason: "no converter is installed on this bridge" };
  }
  const key = keyOf(req);
  if (inflight.has(key)) return { status: "running" };
  const last = finishedAt.get(key);
  if (last !== undefined && now - last < COOLDOWN_MS) return { status: "cooling" };

  const start = (): Promise<void> =>
    new Promise<void>((done) => {
      const args = [
        converter, "build",
        "--repo", req.repoPath,
        "--repo-id", req.repoId,
        "--board", req.boardPath,
        "--cache", req.cacheDir,
      ];
      for (const [k, v] of Object.entries(req.modelPaths)) args.push("--model-path", `${k}=${v}`);
      // `execPath` rather than a bare "node": a bridge started from a versioned Node install must spawn
      // *that* Node, not whatever a login shell would have found — the .deb's own unit does exactly this.
      const child = spawn(process.execPath, args, { stdio: "ignore", detached: false });
      const timer = setTimeout(() => child.kill("SIGKILL"), BUILD_TIMEOUT_MS);
      const finish = (): void => {
        clearTimeout(timer);
        inflight.delete(key);
        finishedAt.set(key, Date.now());
        running -= 1;
        runNext();
        done();
      };
      child.once("error", finish);
      child.once("close", finish);
    });

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const promise = gate.then(start);
  inflight.set(key, { promise, startedAt: now });

  if (running < MAX_CONCURRENT) {
    running += 1;
    release();
    return { status: "running" };
  }
  queue.push(release);
  return { status: "queued" };
}

/** Await every in-flight build. Tests only — nothing on the request path may wait for a conversion. */
export async function drainBuilds(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight.values()].map((e) => e.promise));
}

export { COOLDOWN_MS, MAX_CONCURRENT };
