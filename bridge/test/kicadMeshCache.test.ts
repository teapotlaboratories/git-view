import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  meshKey, blobPath, hasBlob, putBlob, putManifest, getManifest, meshCoverage, meshFor, isMeshKey,
  MESH_FORMAT_VERSION, type BoardManifest,
} from "../src/kicad/meshCache.js";
import { buildGlb, inspectGlb } from "../src/kicad/glb.js";

/**
 * The ahead-of-time mesh cache and the glTF it stores (ADR-038, Phase 4a).
 *
 * The properties worth pinning are the ones that decide whether stale or broken geometry can reach a
 * renderer — a mesh that draws the wrong thing is worse than one that fails to load, because nothing
 * about it looks wrong.
 */

const dirs: string[] = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {}))));
async function cache(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "gv-mesh-"));
  dirs.push(d);
  return d;
}

const tri = () => ({
  position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  index: new Uint32Array([0, 1, 2]),
});

test("the key is over content, so the same part converts once however it is addressed", () => {
  // The point of content-addressing: one part is referenced under several variable names, from several
  // boards, in several repos. Reuse is 22x within a single board before any of that.
  const a = meshKey({ source: new Uint8Array([1, 2, 3]) });
  const b = meshKey({ source: new Uint8Array([1, 2, 3]) });
  const c = meshKey({ source: new Uint8Array([1, 2, 4]) });
  assert.equal(a, b, "same bytes, same key");
  assert.notEqual(a, c, "different bytes, different key");
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("a blob is written atomically and leaves no partial file behind", async () => {
  // The converter and the bridge are different processes. A reader must never see a half-written mesh,
  // and a converter killed mid-write must not leave one that `hasBlob` reports as done.
  const dir = await cache();
  const key = meshKey({ source: new Uint8Array([9]) });
  assert.equal(hasBlob(dir, key), false, "not there before");
  const glb = buildGlb([tri()]);
  await putBlob(dir, key, glb);
  assert.equal(hasBlob(dir, key), true);
  assert.deepEqual(new Uint8Array(await readFile(blobPath(dir, key))), glb, "byte-identical");
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(join(dir, "blobs", key.slice(0, 2)));
  assert.deepEqual(files.filter((f) => f.includes("tmp")), [], "no temporary file survives");
});

test("a manifest written by an older format is treated as absent, not partially trusted", async () => {
  // A format bump changes what the key means, so the blobs an old manifest names are not the geometry we
  // would now build. Serving them would be stale geometry that renders — the failure nobody notices.
  const dir = await cache();
  const m: BoardManifest = {
    formatVersion: MESH_FORMAT_VERSION,
    board: "hw/board.kicad_pcb",
    builtAt: "2026-08-03T00:00:00Z",
    entries: [{ raw: "${KICAD9_3DMODEL_DIR}/x.step", key: "a".repeat(64), tris: 12, bytes: 400 }],
  };
  await putManifest(dir, "repo1", m);
  assert.ok(await getManifest(dir, "repo1", "hw/board.kicad_pcb"), "current version reads back");

  await putManifest(dir, "repo1", { ...m, formatVersion: MESH_FORMAT_VERSION + 1 });
  assert.equal(await getManifest(dir, "repo1", "hw/board.kicad_pcb"), undefined, "a newer/other format is not used");
});

test("a missing or unreadable manifest is 'no meshes', not an error", async () => {
  // A cache the operator has not built is the normal state on day one, and the UI already shows it.
  const dir = await cache();
  assert.equal(await getManifest(dir, "repo1", "never/built.kicad_pcb"), undefined);
  const { manifestPath } = await import("../src/kicad/meshCache.js");
  const p = manifestPath(dir, "repo1", "bad.kicad_pcb");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "boards"), { recursive: true });
  await writeFile(p, "{ this is not json");
  assert.equal(await getManifest(dir, "repo1", "bad.kicad_pcb"), undefined, "unreadable is also just absent");
});

test("manifests for the same board path in different repos do not collide", async () => {
  // Two repos can hold a board at the same relative path; one manifest overwriting the other would show
  // one board's coverage against the other's geometry.
  const dir = await cache();
  const base = { formatVersion: MESH_FORMAT_VERSION, board: "hw/b.kicad_pcb", builtAt: "2026-08-03T00:00:00Z" };
  await putManifest(dir, "repoA", { ...base, entries: [{ raw: "a.step", key: "a".repeat(64) }] });
  await putManifest(dir, "repoB", { ...base, entries: [] });
  assert.equal((await getManifest(dir, "repoA", "hw/b.kicad_pcb"))!.entries.length, 1);
  assert.equal((await getManifest(dir, "repoB", "hw/b.kicad_pcb"))!.entries.length, 0);
});

test("coverage separates 'could not convert' from 'could not find'", async () => {
  // Only one of them is fixed by configuration. An operator who cannot tell them apart cannot act.
  const cov = meshCoverage({
    formatVersion: MESH_FORMAT_VERSION, board: "b", builtAt: "",
    entries: [
      { raw: "1", key: "k1", tris: 100, bytes: 1000 },
      { raw: "2", key: "k2", tris: 50, bytes: 500 },
      { raw: "3", failure: "unresolved" },
      { raw: "4", failure: "convert-failed" },
      // A project-local WRL. Not broken, and not fixable by configuration — the corpus has 18 of them,
      // so lumping it in with "conversion failed" would send an operator looking for a damaged file.
      { raw: "5", failure: "unsupported-format" },
    ],
  });
  assert.deepEqual(cov, { ready: 2, failed: 1, unresolved: 1, unsupported: 1, tris: 150, bytes: 1500 });
  assert.deepEqual(meshCoverage(undefined),
    { ready: 0, failed: 0, unresolved: 0, unsupported: 0, tris: 0, bytes: 0 },
    "an unbuilt cache reports zeroes rather than throwing");
});

test("the glb it writes is a glb", async () => {
  const glb = buildGlb([tri()]);
  const got = inspectGlb(glb);
  assert.equal(got.ok, true, got.error);
  assert.equal(got.tris, 1);
  assert.equal(got.primitives, 1);
  assert.equal(glb.byteLength % 4, 0, "glTF requires 4-byte alignment throughout");
});

test("a corrupted blob is detected rather than served", async () => {
  // The whole point of `inspectGlb`. A truncated cache entry — a full disk, a killed process before
  // atomic writes existed — must be reportable, not handed to a renderer to fail opaquely.
  const glb = buildGlb([tri()]);
  assert.equal(inspectGlb(glb.slice(0, glb.byteLength - 8)).ok, false, "truncated");
  const badMagic = new Uint8Array(glb); badMagic[0] = 0;
  assert.equal(inspectGlb(badMagic).ok, false, "not a glb at all");
  // Structurally, at the opening brace. A first attempt corrupted byte 24 instead — which lands inside
  // a quoted key, so `{"as{et": …}` is still perfectly valid JSON and the check passed while claiming to
  // have failed. The test was wrong, not the code.
  const badJson = new Uint8Array(glb); badJson[20] = 0x41;
  const r = inspectGlb(badJson);
  assert.equal(r.ok, false, "unparseable JSON chunk");
  assert.match(r.error!, /JSON/);

  // What this does NOT catch, stated rather than implied: a flipped bit inside a string or a float still
  // parses. The corruption this defends against is truncation and partial writes — a full disk, a killed
  // process — not random bit rot, which would need the blob hashed on read. The key IS the hash of the
  // source, not of the blob, so that check is available if it ever proves necessary.
});

test("multiple solids stay separate primitives", () => {
  // Same rule as the board's per-component instances: merging is lossy, and anything that later wants to
  // address one part would need the export redone.
  const got = inspectGlb(buildGlb([tri(), tri(), tri()]));
  assert.equal(got.primitives, 3);
  assert.equal(got.tris, 3);
});

test("an empty mesh is skipped rather than emitted with infinite bounds", () => {
  // `min`/`max` over no vertices is +/-Infinity, which is neither valid JSON nor valid glTF — it would
  // produce a file that writes fine and fails at the reader.
  const glb = buildGlb([{ position: new Float32Array(), index: new Uint32Array() }, tri()]);
  const got = inspectGlb(glb);
  assert.equal(got.ok, true, got.error);
  assert.equal(got.primitives, 1, "only the real one");
  assert.ok(!Buffer.from(glb).toString("latin1").includes("Infinity"), "and no Infinity reached the JSON");
});

test("a manifest key that is not a hash never becomes a path", () => {
  // The one property that matters on the serving side. A manifest is a file on disk: our converter writes
  // it, but the bridge *reads* it on the request path, and a hand-edited or corrupted one containing a
  // traversal must not turn into a file read. The client's own input never reaches a path at all — it is
  // only ever matched against `raw`.
  const m: BoardManifest = {
    formatVersion: MESH_FORMAT_VERSION, board: "b", builtAt: "",
    entries: [
      { raw: "evil", key: "../../../../etc/passwd" },
      { raw: "alsoevil", key: "a".repeat(63) + "/" },
      { raw: "shouty", key: "A".repeat(64) },
      { raw: "fine", key: "b".repeat(64), tris: 9, bytes: 90 },
    ],
  };
  assert.equal(meshFor(m, "evil").ok, false);
  assert.equal((meshFor(m, "evil") as { reason: string }).reason, "bad-key");
  assert.equal((meshFor(m, "alsoevil") as { reason: string }).reason, "bad-key");
  assert.equal((meshFor(m, "shouty") as { reason: string }).reason, "bad-key", "hex is lowercase; uppercase is not a key we wrote");
  assert.deepEqual(meshFor(m, "fine"), { ok: true, key: "b".repeat(64), tris: 9, bytes: 90 });

  assert.equal(isMeshKey("../x"), false);
  assert.equal(isMeshKey(""), false);
  assert.equal(isMeshKey("c".repeat(64)), true);
});

test("the four ways there is no mesh stay distinguishable", () => {
  // They mean different things to whoever is looking: nobody built a cache, this board does not use that
  // model, it is known but could not be built, or the manifest is not trustworthy. Collapsing them into
  // one 404 would leave an operator with no idea whether to run the converter or fix their config.
  const m: BoardManifest = {
    formatVersion: MESH_FORMAT_VERSION, board: "b", builtAt: "",
    entries: [{ raw: "unsupported.wrl", failure: "unsupported-format" }],
  };
  assert.equal((meshFor(undefined, "x") as { reason: string }).reason, "not-built");
  assert.equal((meshFor(m, "never-heard-of-it") as { reason: string }).reason, "unknown-model");
  const nr = meshFor(m, "unsupported.wrl") as { reason: string; failure: string };
  assert.equal(nr.reason, "not-ready");
  assert.equal(nr.failure, "unsupported-format", "and carries WHY, so the message can be actionable");
});

test("a reference is matched exactly, never by prefix or path shape", () => {
  // `meshFor` takes client input. If it ever matched loosely, one model could be served in place of
  // another — the wrong part rendering is the failure mode this whole feature is trying to avoid.
  const m: BoardManifest = {
    formatVersion: MESH_FORMAT_VERSION, board: "b", builtAt: "",
    entries: [{ raw: "${KICAD9_3DMODEL_DIR}/R.step", key: "d".repeat(64) }],
  };
  assert.equal(meshFor(m, "${KICAD9_3DMODEL_DIR}/R.step").ok, true);
  for (const near of ["${KICAD9_3DMODEL_DIR}/R.ste", "${KICAD9_3DMODEL_DIR}/R.step ",
                      "R.step", "${KICAD8_3DMODEL_DIR}/R.step", "${KICAD9_3DMODEL_DIR}/../R.step"]) {
    assert.equal(meshFor(m, near).ok, false, `${near} must not match`);
  }
});
