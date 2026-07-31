/**
 * Serving KiCad scenes to the app (ADR-038, Phase 1).
 *
 * Three things this layer is responsible for, all of them decisions from the ADR rather than incidental:
 *
 *  - **On demand, never eagerly.** Parsing is triggered by a client opening a sheet, not by the watcher.
 *    On a repo the size of rimba, parsing off file-change events would turn one branch switch into a
 *    storm of parses for files nobody is looking at.
 *  - **Cached by content, not by path.** The key is the resolved commit oid plus the sheet path, which is
 *    already content-addressed: an oid names immutable content, so a hit is always correct. The working
 *    tree is deliberately never cached — it changes under us.
 *  - **Confined.** `loadDesign` follows `Sheetfile` paths out of the file, which is repository content and
 *    therefore attacker-controlled. It refuses to leave the root sheet's directory on its own, and the
 *    reader here goes through `readBlob`, which confines again (realpath, symlink-aware). Two independent
 *    checks, because this is the first place the parser meets untrusted input.
 */
import { buildScene, type Scene } from "./scene.js";
import { loadDesign, type Design } from "./design.js";

/** Reads a repo-relative path at a resolved ref. Supplied by the caller so this module never touches fs. */
export type BlobReader = (path: string) => Promise<string>;

interface Entry {
  design: Design;
  /** Scenes built so far, by instance path. Filled lazily — see `getScene`. */
  scenes: Map<string, Scene>;
}

/**
 * How much parsed design to keep. The largest demo design is ~1.5 MB of source; this holds a good number
 * of real ones. A cap on *entries* rather than bytes, because measuring retained size accurately is not
 * worth the complexity.
 */
const MAX_DESIGNS = 32;

/** Cache of solved designs, keyed by `oid rootPath`. Insertion-ordered, evicting oldest first. */
const cache = new Map<string, Entry>();

function remember(key: string, entry: Entry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_DESIGNS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** The working tree is never cached: it can change between two requests with no ref to tell us. */
const cacheable = (resolved: string, worktree: string) => resolved !== worktree;

export interface SceneRequest {
  /** Resolved ref — a commit oid, or the worktree sentinel. Part of the cache key. */
  resolved: string;
  /** Sentinel value meaning "working tree", so this module needs no git import to recognise it. */
  worktreeSentinel: string;
  /** Repo-relative path of the **root** sheet of the design. */
  rootPath: string;
  /** Which sheet instance to draw. Defaults to the root sheet. */
  instancePath?: string;
  read: BlobReader;
}

/**
 * Get one sheet's scene, solving the design if it is not already cached.
 *
 * **Exactly one scene is built per request.** Building every sheet up front looked attractive — the solve
 * is already paid for, so the sheet switcher would be instant — and it was wrong: a malformed schematic
 * that fans out to the placement cap made a single request take **70 seconds**, because it built 2000
 * scenes inline. The solve itself is bounded and fast; rendering is what scales with placement count.
 * ADR-038 says warm siblings *in the background*, and that is the difference between a fast request and a
 * bridge nobody else can use. Sibling scenes are cached as they are asked for.
 */
export async function getScene(req: SceneRequest): Promise<Scene> {
  const key = `${req.resolved}\u0000${req.rootPath}`;
  const canCache = cacheable(req.resolved, req.worktreeSentinel);

  let entry = canCache ? cache.get(key) : undefined;
  if (!entry) {
    entry = { design: await loadDesign(req.rootPath, req.read), scenes: new Map() };
    if (canCache) remember(key, entry);
  } else {
    remember(key, entry); // refresh recency
  }

  const want = req.instancePath ?? entry.design.instances[0]!.path;
  const cached = entry.scenes.get(want);
  if (cached) return cached;

  const inst = entry.design.instances.find((i) => i.path === want);
  if (!inst) throw new Error(`no sheet instance ${want} in ${req.rootPath}`);
  const scene = buildScene(entry.design, inst.path, await req.read(inst.file));
  entry.scenes.set(want, scene);
  return scene;
}

/** Drop everything. Used by tests; a bridge has no reason to call it. */
export function clearSceneCache(): void {
  cache.clear();
}

/** Cache size, for tests and diagnostics. */
export function sceneCacheSize(): number {
  return cache.size;
}
