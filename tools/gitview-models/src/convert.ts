/**
 * Turning one model file into a mesh (ADR-038, Phase 4a).
 *
 * This is the only place in the project that touches a CAD kernel, and it is deliberately not in the
 * bridge. Measured on the corpus, `ReadStepFile` costs 0.37 s for a median official-library part, 6.4 s
 * for a `TQFP-100`, and 101.7 s at **1.7 GB of RSS** for a 25 MB vendor model — and it is synchronous.
 * In a request path that means the bridge stops answering anything at all for the duration; in a CLI it
 * means the CLI takes a while, which is what a build tool is allowed to do.
 *
 * Everything here is therefore free to be simple: no worker pool, no streaming, no cancellation.
 */
import { readFileSync } from "node:fs";
import { Decompress } from "fzstd";
import occtimportjs from "occt-import-js";
import { buildGlb, type MeshInput } from "../../../bridge/src/kicad/glb.js";
import { MESH_DEFLECTION } from "../../../bridge/src/kicad/meshCache.js";
import { CONVERTIBLE_EXTS } from "../../../bridge/src/kicad/modelResolve.js";

type Occt = {
  ReadStepFile: (b: Uint8Array, p: unknown) => OcctResult;
  ReadBrepFile: (b: Uint8Array, p: unknown) => OcctResult;
};
interface OcctResult {
  success: boolean;
  meshes: {
    attributes?: { position?: { array: number[] }; normal?: { array: number[] } };
    index?: { array: number[] };
    color?: number[];
  }[];
}

let occt: Occt | undefined;

/**
 * Load the kernel once per process.
 *
 * Worth doing explicitly: the first call into the WASM module costs ~1.2 s extra (measured — the same
 * capacitor five times runs 1530, 386, 272, 356, 241 ms), so a converter that instantiated per file
 * would pay it on every one.
 */
export async function kernel(): Promise<Occt> {
  // Silence the kernel's own stdout/stderr. OCCT prints C++ diagnostics per malformed file — a board of
  // vendor models produces a screenful — and every one of them is already captured per model in the
  // manifest, where it is attached to the reference it belongs to instead of scrolling past unattributed.
  occt ??= (await occtimportjs({ print: () => {}, printErr: () => {} })) as Occt;
  return occt;
}

/** What a conversion produced, or why it did not. */
export interface Converted {
  glb?: Uint8Array;
  tris: number;
  error?: string;
}

/**
 * Ceiling on an embedded payload, applied while decompressing.
 *
 * The largest real one measured is a 448 KB STEP from 72 KB compressed; 64 MB is far above anything a
 * board legitimately carries and far below anything that hurts. It exists because a `.kicad_pcb` is
 * repository content: a small payload that expands without bound is a decompression bomb, and the
 * `--max-mb` check downstream caps what gets *converted*, not what gets *allocated*.
 */
export const MAX_EMBEDDED_BYTES = 64 * 1024 * 1024;

/** Thrown when a payload exceeds [MAX_EMBEDDED_BYTES]; the CLI records it per model and carries on. */
export class EmbeddedTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`embedded payload exceeds ${MAX_EMBEDDED_BYTES} bytes (reached ${bytes})`);
  }
}

/**
 * Decompress an embedded payload.
 *
 * KiCad 9 stores embedded files zstd-compressed and base64-encoded. Node 22.14 has no zstd in `zlib`
 * (it arrives in 22.15), hence `fzstd` — and since this is the converter, adding a dependency here
 * costs the bridge nothing.
 */
export function decodeEmbedded(base64: string, maxBytes = MAX_EMBEDDED_BYTES): Uint8Array {
  const raw = Buffer.from(base64.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  // Only zstd is used in practice, but an uncompressed payload is legal and cheap to allow.
  const isZstd = raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd;
  if (!isZstd) {
    if (raw.byteLength > maxBytes) throw new EmbeddedTooLarge(raw.byteLength);
    return new Uint8Array(raw);
  }

  // Decompressed through the streaming API so the budget bounds the *decompression*, not its result. A
  // size check afterwards caps what we convert while still letting a small payload expand without limit
  // first, and these bytes come out of repository content like every other model reference.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const d = new Decompress((chunk) => {
    total += chunk.length;
    if (total > maxBytes) throw new EmbeddedTooLarge(total);
    chunks.push(chunk);
  });
  d.push(new Uint8Array(raw), true);

  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Is this something the kernel can read? WRL is not — see the plan; it needs a different reader.
 *
 * The list lives in the bridge's `modelResolve`, which uses the same answer to decide *ordering* — a
 * convertible twin outranks a non-convertible named file. Two copies drift silently and in the worst
 * direction: a format added here but not there would be resolved *after* a `.wrl` and never reached.
 */
export function isConvertible(name: string): boolean {
  const i = name.lastIndexOf(".");
  return i >= 0 && CONVERTIBLE_EXTS.has(name.slice(i).toLowerCase());
}

/**
 * Convert model bytes to a `.glb`.
 *
 * Never throws. A board full of vendor models will contain some the kernel cannot read, and the useful
 * outcome is a manifest that says which — not a build that stops on the first bad file.
 */
export async function convert(source: Uint8Array): Promise<Converted> {
  let r: OcctResult;
  try {
    const k = await kernel();
    r = k.ReadStepFile(source, { linearDeflection: MESH_DEFLECTION, angularDeflection: 0.5 });
  } catch (e) {
    return { tris: 0, error: `kernel threw: ${String(e).slice(0, 120)}` };
  }
  if (!r?.success) return { tris: 0, error: "kernel could not read the file" };

  const meshes: MeshInput[] = [];
  let tris = 0;
  for (const m of r.meshes) {
    const pos = m.attributes?.position?.array;
    const idx = m.index?.array;
    if (!pos?.length || !idx?.length) continue;
    const nrm = m.attributes?.normal?.array;
    meshes.push({
      position: new Float32Array(pos),
      normal: nrm?.length === pos.length ? new Float32Array(nrm) : undefined,
      index: new Uint32Array(idx),
      color: m.color?.length === 3 ? [m.color[0]!, m.color[1]!, m.color[2]!] : undefined,
    });
    tris += idx.length / 3;
  }
  if (!meshes.length) return { tris: 0, error: "read, but produced no geometry" };
  return { glb: buildGlb(meshes), tris };
}
