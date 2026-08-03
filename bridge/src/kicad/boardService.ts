/**
 * Serving KiCad **boards** to the app (ADR-038, Phase 3).
 *
 * The same shape as `service.ts` does for schematics — on demand, cached by content, never eagerly — with
 * one difference that drives everything here: **a board is parsed once and read many times.**
 *
 * On `vme-wren` (66 MB) the split is stark: parsing costs **3.9 s**, building the index **0.4 s**, and
 * serving one layer **0.27 s**. Before parse and serve were separated, every layer request re-parsed and
 * cost 6.5 s. So the cached unit is the *parsed tree*, not the finished scene: the client asks for the
 * index, then for whichever layers it actually draws, and pays the 3.9 s once.
 */
import {
  parseBoard,
  readBoard,
  readBoardLayer,
  type Board,
  type BoardLayerScene,
  type ParsedBoard,
} from "./board.js";
import type { BlobReader } from "./service.js";

/**
 * How much parsed board to keep, **in source bytes**.
 *
 * This started as a count of four entries, defended by "holding 32 of those would be gigabytes". That
 * reasoning disproved itself and I shipped it anyway: four is *also* gigabytes. Measured on `vme-wren`
 * with `--expose-gc`:
 *
 * | | |
 * | --- | --- |
 * | source on disk | 66 MB |
 * | as a JS string | 133 MB |
 * | parsed tree adds | 617 MB |
 * | **one cached board** | **750 MB** |
 *
 * So four entries is ~3 GB on a bridge that is often someone's spare machine. Entries were the wrong
 * quantity to bound; bytes are the one that hurts.
 *
 * The budget is on *source* size because that is knowable for free — the parsed tree runs roughly 11× it,
 * so 48 MB of source is on the order of half a gigabyte retained, which is a defensible ceiling for a
 * background service. Several small boards coexist happily; two huge ones cannot.
 */
const MAX_BOARD_SOURCE_BYTES = 48 * 1024 * 1024;

interface Entry {
  parsed: ParsedBoard;
  /** Source bytes this entry stands for — the budget is charged against this. */
  bytes: number;
}

const cache = new Map<string, Entry>();

/**
 * Cache key for (ref, path).
 *
 * `JSON.stringify` of the pair rather than concatenation with a separator. The schematic service joins
 * with an escaped NUL, which is correct — but writing that as a *literal* NUL instead of an escape has
 * bitten this repo three times, turning the source into a file `grep -I` skips silently and git renders as
 * `Bin 0 -> N bytes`, i.e. unreviewable. Encoding the tuple sidesteps the question entirely: it is
 * injective without needing a separator that cannot occur in the inputs, so ("ab","c") and ("a","bc")
 * cannot collide on one entry.
 */
const cacheKey = (resolved: string, path: string): string => JSON.stringify([resolved, path]);

function remember(key: string, entry: Entry): void {
  cache.delete(key);
  cache.set(key, entry);
  // Evict oldest-first until the budget holds, but **never evict the last entry**: the board someone is
  // looking at right now has to stay, or every layer toggle re-parses and the cache is worse than none.
  // A single board over budget is therefore allowed — one is the cost of serving it at all.
  let total = 0;
  for (const e of cache.values()) total += e.bytes;
  while (total > MAX_BOARD_SOURCE_BYTES && cache.size > 1) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    total -= cache.get(oldest.value)?.bytes ?? 0;
    cache.delete(oldest.value);
  }
}

/** The working tree is never cached: it can change between two requests with no ref to tell us. */
const cacheable = (resolved: string, worktree: string) => resolved !== worktree;

export interface BoardRequest {
  /** Resolved ref — a commit oid, or the worktree sentinel. Part of the cache key. */
  resolved: string;
  /** Sentinel meaning "working tree", so this module needs no git import to recognise it. */
  worktreeSentinel: string;
  /** Repo-relative path of the `.kicad_pcb`. */
  path: string;
  read: BlobReader;
}

async function parsed(req: BoardRequest): Promise<ParsedBoard> {
  const key = cacheKey(req.resolved, req.path);
  const canCache = cacheable(req.resolved, req.worktreeSentinel);

  const hit = canCache ? cache.get(key) : undefined;
  if (hit) {
    remember(key, hit); // refresh recency
    return hit.parsed;
  }
  const text = await req.read(req.path);
  const fresh = parseBoard(text);
  if (canCache) remember(key, { parsed: fresh, bytes: text.length });
  return fresh;
}

/**
 * The index: layers with their populations, components, nets, extent. **No geometry.**
 *
 * This is what makes per-layer fetching usable — the client can see that `User.9` holds 286,621 elements
 * and `F.Cu` holds 20,887 *before* asking for either, and pick accordingly.
 */
export async function getBoardIndex(req: BoardRequest): Promise<Board> {
  return readBoard(await parsed(req));
}

/** One layer's drawables. `includeZones: false` drops the copper pours and keeps the routing. */
export async function getBoardLayer(
  req: BoardRequest,
  layer: string,
  opts: { includeZones?: boolean } = {},
): Promise<BoardLayerScene> {
  return readBoardLayer(await parsed(req), layer, opts);
}

/** Drop everything. Used by tests; a bridge has no reason to call it. */
export function clearBoardCache(): void {
  cache.clear();
}

/** Cache size, for tests and diagnostics. */
export function boardCacheSize(): number {
  return cache.size;
}
