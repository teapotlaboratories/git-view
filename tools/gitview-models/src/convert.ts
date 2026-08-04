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
import { decompress } from "fzstd";
import occtimportjs from "occt-import-js";
import { buildGlb, type MeshInput } from "../../../bridge/src/kicad/glb.js";
import { MESH_DEFLECTION } from "../../../bridge/src/kicad/meshCache.js";

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
 * Decompress an embedded payload.
 *
 * KiCad 9 stores embedded files zstd-compressed and base64-encoded. Node 22.14 has no zstd in `zlib`
 * (it arrives in 22.15), hence `fzstd` — and since this is the converter, adding a dependency here
 * costs the bridge nothing.
 */
export function decodeEmbedded(base64: string): Uint8Array {
  const raw = Buffer.from(base64.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  // Only zstd is used in practice, but an uncompressed payload is legal and cheap to allow.
  const isZstd = raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd;
  return isZstd ? decompress(new Uint8Array(raw)) : new Uint8Array(raw);
}

/** Is this something the kernel can read? WRL is not — see the plan; it needs a different reader. */
export function isConvertible(name: string): boolean {
  return /\.(step|stp)$/i.test(name);
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
