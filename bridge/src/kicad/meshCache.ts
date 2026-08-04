/**
 * The ahead-of-time mesh cache (ADR-038, Phase 4a).
 *
 * Converting STEP to a mesh needs a CAD kernel, and measuring one said it cannot live in the request
 * path: 0.37 s median for an official-library part, 6.4 s for a `TQFP-100`, 101.7 s and **1.7 GB of RSS**
 * for a 25 MB vendor model. So conversion happens ahead of time, in a separate tool, and the bridge only
 * ever reads what that tool left behind. This module is the contract between them — it is deliberately
 * in the bridge, with no dependency on any kernel, so both sides agree on layout without the bridge
 * carrying 7.6 MB of WASM it would never call.
 *
 * **Blobs are keyed by content, manifests by board.** Those answer different questions:
 *
 *  - *"have we already converted these bytes?"* — content, because the same part is referenced under
 *    several variable names, from several boards, in several repos. Reuse is 22× within one board alone.
 *  - *"what can this board show?"* — per board, because that is asked on every index request, and the
 *    alternative is hashing every referenced model each time. A 25 MB STEP would be re-read on every
 *    request to answer a question whose answer did not change.
 *
 * A manifest also gives embedded models somewhere to be named. They have no host path at all, so a
 * path-keyed design could not describe them.
 */
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Bumped when a change would make previously written blobs wrong rather than merely older — a different
 * tessellation tolerance, a different glTF layout. It is part of the key, so a bump orphans old entries
 * instead of serving them: stale geometry that renders is worse than none, because nothing looks wrong.
 */
export const MESH_FORMAT_VERSION = 1;

/** Deflection passed to the tessellator, in mm. Part of the key — see [MESH_FORMAT_VERSION]. */
export const MESH_DEFLECTION = 0.1;

export interface MeshKeyParts {
  /** Raw bytes of the source model — the STEP/WRL file, or an embedded payload after decompression. */
  source: Uint8Array;
}

/**
 * The cache key for a model's bytes.
 *
 * Includes the format version and deflection so that changing either cannot silently return geometry
 * built to the old settings.
 */
export function meshKey({ source }: MeshKeyParts): string {
  return createHash("sha256")
    .update(`gitview-mesh\0${MESH_FORMAT_VERSION}\0${MESH_DEFLECTION}\0`)
    .update(source)
    .digest("hex");
}

/**
 * Is this a key we are willing to turn into a path?
 *
 * A manifest is a file on disk. It is written by our own converter, but it is *read* on the request
 * path, and the only thing standing between its contents and `join(cacheDir, …)` is this check. A
 * hand-edited or corrupted manifest containing `../../etc/passwd` must not become a file read — the
 * same rule the model resolver applies to references out of repository content.
 */
export function isMeshKey(k: string): boolean {
  return /^[0-9a-f]{64}$/.test(k);
}

/**
 * Where a blob lives. Fanned out by the first byte of the hash: a corpus-wide cache reaches thousands of
 * entries, and some filesystems degrade badly on a single directory that size.
 */
export function blobPath(cacheDir: string, key: string): string {
  return join(cacheDir, "blobs", key.slice(0, 2), `${key}.glb`);
}

/** Is this mesh already converted? */
export function hasBlob(cacheDir: string, key: string): boolean {
  return existsSync(blobPath(cacheDir, key));
}

/**
 * Write a blob, atomically.
 *
 * Via a temporary file and `rename` because the converter and the bridge run as different processes: a
 * reader must never observe a half-written mesh, and a converter killed mid-write must not leave one
 * that `hasBlob` will happily report as done.
 */
export async function putBlob(cacheDir: string, key: string, bytes: Uint8Array): Promise<string> {
  const path = blobPath(cacheDir, key);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
  return path;
}

/** Why a model has no mesh. Distinguished because only some of these are worth an operator's time. */
export type MeshFailure =
  /** The source could not be located — see `modelResolve`, which says why in more detail. */
  | "unresolved"
  /** Located, but the kernel could not read it. A broken file. */
  | "convert-failed"
  /**
   * Located, and a format we do not convert — in practice a `.wrl`.
   *
   * Kept apart from `convert-failed` because the two ask different things of whoever reads them. A
   * conversion failure suggests a damaged file worth looking at; this one is a statement about us, and
   * nothing the operator does to the file will change it. The corpus has 18 project-local WRLs, so it
   * is a recurring outcome rather than an edge case.
   */
  | "unsupported-format"
  /** Skipped deliberately, e.g. over a size limit the operator set. */
  | "skipped";

export interface ManifestEntry {
  /** The reference exactly as the board writes it — `${KICAD9_3DMODEL_DIR}/…` or `kicad-embed://…`. */
  raw: string;
  /** Content key, when it converted. */
  key?: string;
  /** Triangle count, carried so a client can decide before fetching. */
  tris?: number;
  /** Byte length of the blob, likewise. */
  bytes?: number;
  /** Why not, when it did not. */
  failure?: MeshFailure;
  /** One line of detail for a human — never shown to a client, never a host path. */
  detail?: string;
}

export interface BoardManifest {
  formatVersion: number;
  /** Repo-relative path of the board this describes. */
  board: string;
  /** ISO timestamp of the run that wrote it. */
  builtAt: string;
  entries: ManifestEntry[];
}

/**
 * Manifests are keyed by repo id + board path rather than stored beside the board.
 *
 * A repo is read-only as far as the bridge is concerned — it is somebody's git checkout, and dropping
 * generated files into it would show up in their `git status`.
 */
export function manifestPath(cacheDir: string, repoId: string, boardPath: string): string {
  const h = createHash("sha256").update(`${repoId}\0${boardPath}`).digest("hex");
  return join(cacheDir, "boards", `${h}.json`);
}

export async function putManifest(cacheDir: string, repoId: string, m: BoardManifest): Promise<string> {
  const path = manifestPath(cacheDir, repoId, m.board);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(m, null, 1));
  await rename(tmp, path);
  return path;
}

/**
 * Read a board's manifest, or undefined if it has never been built.
 *
 * Never throws: an absent or unreadable manifest means "no meshes for this board", which is a state the
 * UI already has to show. A cache the operator has not built yet is not an error condition.
 */
export async function getManifest(
  cacheDir: string,
  repoId: string,
  boardPath: string,
): Promise<BoardManifest | undefined> {
  try {
    const m = JSON.parse(await readFile(manifestPath(cacheDir, repoId, boardPath), "utf8")) as BoardManifest;
    // A manifest written by an older format describes blobs whose key no longer matches what we would
    // compute, so its entries cannot be served. Treated as absent rather than partially trusted.
    return m.formatVersion === MESH_FORMAT_VERSION ? m : undefined;
  } catch {
    return undefined;
  }
}

export interface MeshCoverage {
  /** References with a mesh ready to serve. */
  ready: number;
  /** Located but not converted — the kernel could not read them. */
  failed: number;
  /** No source found at all; `modelResolve` explains which flavour. */
  unresolved: number;
  /** Found, but in a format we do not convert. Not fixable by configuration — see [MeshFailure]. */
  unsupported: number;
  /**
   * Deliberately not converted — over the operator's own size limit.
   *
   * Counted apart from [failed] because the two ask for different actions: a failure says *look at this
   * file*, a skip says *raise `--max-mb` if you want it*. Folding them together reports conversion
   * failures for models the operator chose to exclude.
   */
  skipped: number;
  /** Total triangles across ready meshes, so a client can judge before asking for any. */
  tris: number;
  /** Total bytes likewise. */
  bytes: number;
}

/** What answering a mesh request produced. */
export type MeshLookup =
  | { ok: true; key: string; tris: number; bytes: number }
  | { ok: false; reason: "not-built" | "unknown-model" | "not-ready" | "bad-key"; failure?: MeshFailure };

/**
 * Which blob answers this reference, if any.
 *
 * The reference comes from the client and is therefore attacker-controlled — so it is used only as a
 * *lookup* in the manifest, never as part of a path. What becomes a path is the key the manifest
 * supplies, and only after [isMeshKey] agrees it is a hash.
 *
 * The four negative answers are kept apart because they mean different things to whoever is looking:
 * nobody has built a cache, this board does not reference that model at all, the model is known but has
 * no mesh (and the manifest says why), or the manifest is not trustworthy.
 */
export function meshFor(m: BoardManifest | undefined, raw: string): MeshLookup {
  if (!m) return { ok: false, reason: "not-built" };
  const e = m.entries.find((x) => x.raw === raw);
  if (!e) return { ok: false, reason: "unknown-model" };
  if (!e.key) return { ok: false, reason: "not-ready", failure: e.failure };
  if (!isMeshKey(e.key)) return { ok: false, reason: "bad-key" };
  return { ok: true, key: e.key, tris: e.tris ?? 0, bytes: e.bytes ?? 0 };
}

/** Summarise a manifest for the board index. */
export function meshCoverage(m: BoardManifest | undefined): MeshCoverage {
  const out: MeshCoverage = { ready: 0, failed: 0, unresolved: 0, unsupported: 0, skipped: 0, tris: 0, bytes: 0 };
  for (const e of m?.entries ?? []) {
    if (e.key) { out.ready += 1; out.tris += e.tris ?? 0; out.bytes += e.bytes ?? 0; }
    else if (e.failure === "unresolved") out.unresolved += 1;
    else if (e.failure === "unsupported-format") out.unsupported += 1;
    else if (e.failure === "skipped") out.skipped += 1;
    else out.failed += 1;
  }
  return out;
}
