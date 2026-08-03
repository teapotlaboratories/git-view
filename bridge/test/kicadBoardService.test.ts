import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getBoardIndex,
  getBoardLayer,
  clearBoardCache,
  boardCacheSize,
} from "../src/kicad/boardService.js";

/**
 * Serving boards (ADR-038, Phase 3).
 *
 * The reader's own tests cover what a board *means*. These cover what the service adds on top, which is
 * one idea: **parse once, read many times.** On `vme-wren` (66 MB) parsing costs 3.9 s and serving a layer
 * costs 0.27 s, so whether the parse is reused is the difference between a usable feature and a 6-second
 * wait per layer toggle. That is exactly the kind of property a passing build says nothing about.
 */

const WORKTREE = "::worktree::";

const BOARD = `(kicad_pcb (version 20241229) (generator "test")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND")
  (segment (start 0 0) (end 10 0) (width 0.2) (layer "F.Cu") (net 1))
  (segment (start 0 5) (end 10 5) (width 0.2) (layer "B.Cu") (net 1))
  (gr_line (start 0 0) (end 50 0) (layer "Edge.Cuts") (width 0.1)))`;

/** A reader that counts how often it is asked for the file. */
function counting(text = BOARD) {
  let reads = 0;
  return { read: async () => { reads += 1; return text; }, reads: () => reads };
}

test("the parse is reused across layer requests at the same ref", async () => {
  clearBoardCache();
  const r = counting();
  const req = { resolved: "oid1", worktreeSentinel: WORKTREE, path: "b.kicad_pcb", read: r.read };

  await getBoardIndex(req);
  await getBoardLayer(req, "F.Cu");
  await getBoardLayer(req, "B.Cu");
  await getBoardLayer(req, "Edge.Cuts");

  assert.equal(r.reads(), 1, "four requests, one parse — this is the whole point of the service");
});

test("a different commit is a different parse", async () => {
  // The key is the resolved oid, which names immutable content, so a hit is always correct. Keying on the
  // path alone would serve one commit's copper for another's.
  clearBoardCache();
  const r = counting();
  await getBoardLayer({ resolved: "oid1", worktreeSentinel: WORKTREE, path: "b.kicad_pcb", read: r.read }, "F.Cu");
  await getBoardLayer({ resolved: "oid2", worktreeSentinel: WORKTREE, path: "b.kicad_pcb", read: r.read }, "F.Cu");
  assert.equal(r.reads(), 2);
});

test("the working tree is never cached", async () => {
  // It can change between two requests with no ref to tell us. Caching it would serve a board the user
  // has already edited — the failure is silent and looks like the reader being wrong.
  clearBoardCache();
  const r = counting();
  const req = { resolved: WORKTREE, worktreeSentinel: WORKTREE, path: "b.kicad_pcb", read: r.read };
  await getBoardIndex(req);
  await getBoardLayer(req, "F.Cu");
  assert.equal(r.reads(), 2, "each request re-reads");
  assert.equal(boardCacheSize(), 0, "and nothing is retained");
});

test("the cache is bounded by source bytes, not by entry count", async () => {
  // Measured on vme-wren: 66 MB of source retains 750 MB once parsed. The first version of this cache
  // bounded *entries* at four, which is ~3 GB — the wrong quantity. Small boards should still coexist.
  clearBoardCache();
  const r = counting();
  for (let i = 0; i < 12; i++) {
    await getBoardIndex({ resolved: `oid${i}`, worktreeSentinel: WORKTREE, path: "b.kicad_pcb", read: r.read });
  }
  // The fixture is a few hundred bytes, so every one of them fits the budget together.
  assert.equal(boardCacheSize(), 12, "small boards are not evicted for no reason");
});

test("one board over the whole budget still stays cached", async () => {
  // Never evict the last entry: the board being looked at right now has to survive, or every layer toggle
  // re-parses and the cache is worse than useless. One over-budget board is the price of serving it.
  clearBoardCache();
  const huge = `(kicad_pcb (version 1) (generator "t") (layers (0 "F.Cu" signal)) (net 0 "")` +
    ` ${" ".repeat(60 * 1024 * 1024)})`;
  const r = counting(huge);
  const req = { resolved: "big", worktreeSentinel: WORKTREE, path: "b.kicad_pcb", read: r.read };
  await getBoardIndex(req);
  await getBoardLayer(req, "F.Cu");
  assert.equal(r.reads(), 1, "the over-budget board is still reused rather than re-parsed");
  assert.equal(boardCacheSize(), 1);
});

test("a second huge board evicts the first rather than holding both", async () => {
  // Two of them is the case that would take the bridge down.
  clearBoardCache();
  const huge = (tag: string) => `(kicad_pcb (version 1) (generator "${tag}") (layers (0 "F.Cu" signal))` +
    ` (net 0 "") ${" ".repeat(40 * 1024 * 1024)})`;
  let n = 0;
  const read = async () => huge(`b${n++}`);
  await getBoardIndex({ resolved: "big1", worktreeSentinel: WORKTREE, path: "b.kicad_pcb", read });
  await getBoardIndex({ resolved: "big2", worktreeSentinel: WORKTREE, path: "b.kicad_pcb", read });
  assert.equal(boardCacheSize(), 1, "80 MB of source must not be held at once");
});

test("concurrent requests for an uncached board share one parse", async () => {
  // The cache bounds what is *retained*; nothing bounded what was being built. Three simultaneous requests
  // parsed the board three times — on vme-wren that is 3 x 3.9 s and ~2.25 GB transient, against a 48 MB
  // budget that would then evict two of the three. The window is small and it is exactly the moment the
  // board is most expensive: nobody has it cached, which is when two devices opening the same file collide.
  clearBoardCache();
  let reads = 0;
  const read = async () => { reads += 1; await new Promise((r) => setTimeout(r, 20)); return BOARD; };
  const req = { resolved: "oid1", worktreeSentinel: WORKTREE, path: "b.kicad_pcb", read };
  await Promise.all([getBoardIndex(req), getBoardLayer(req, "F.Cu"), getBoardLayer(req, "B.Cu")]);
  assert.equal(reads, 1, "one parse for three in-flight requests");
});

test("a failed parse is not pinned as a rejected promise", async () => {
  // If the in-flight entry survived a failure, every later request for that board would replay the same
  // error forever — a transient read failure would look permanent.
  clearBoardCache();
  let attempts = 0;
  const read = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient");
    return BOARD;
  };
  const req = { resolved: "oid1", worktreeSentinel: WORKTREE, path: "b.kicad_pcb", read };
  await assert.rejects(() => getBoardIndex(req));
  const ok = await getBoardIndex(req);   // must retry, not replay the failure
  assert.equal(attempts, 2);
  assert.deepEqual(ok.nets, ["GND"]);
});

test("the index carries no geometry, and the layer does", async () => {
  clearBoardCache();
  const r = counting();
  const req = { resolved: "oid1", worktreeSentinel: WORKTREE, path: "b.kicad_pcb", read: r.read };

  const idx = await getBoardIndex(req);
  assert.ok(!("primitives" in idx), "the index must stay small — it is fetched before anything is drawn");
  assert.deepEqual(idx.nets, ["GND"]);
  assert.equal(idx.layers.find((l) => l.name === "F.Cu")?.count, 1);
  assert.deepEqual(idx.bbox, [0, 0, 50, 0], "extent comes from Edge.Cuts");

  const layer = await getBoardLayer(req, "F.Cu");
  assert.equal(layer.primitives.length, 1);
  assert.equal(layer.layer, "F.Cu");
});

test("zones can be dropped per request without disturbing the cached parse", async () => {
  clearBoardCache();
  const withZone = BOARD.replace(
    "(gr_line",
    `(zone (net 1) (layer "F.Cu") (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 5 0) (xy 5 5))))\n  (gr_line`,
  );
  const r = counting(withZone);
  const req = { resolved: "oid1", worktreeSentinel: WORKTREE, path: "b.kicad_pcb", read: r.read };

  const a = await getBoardLayer(req, "F.Cu");
  const b = await getBoardLayer(req, "F.Cu", { includeZones: false });
  assert.ok(a.primitives.some((p) => p.t === "zone"));
  assert.ok(!b.primitives.some((p) => p.t === "zone"));
  assert.equal(r.reads(), 1, "the option is a read-time choice, not a second parse");
});
