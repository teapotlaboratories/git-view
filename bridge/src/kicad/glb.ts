/**
 * Assembling glTF binary (`.glb`) from tessellated meshes (ADR-038, Phase 4a).
 *
 * Written by hand rather than pulled in as a dependency: a `.glb` is a 12-byte header and two chunks —
 * a JSON chunk and a binary one — and the exporters on npm bring a scene graph and a math library to do
 * it. This needs neither. It is also the one file that decides what the Android side has to understand,
 * so it is worth being able to read.
 *
 * glTF rather than a private format because the app can then use an existing renderer. A custom mesh
 * blob would save a little space and cost us a renderer to write, debug and keep.
 */

/** One tessellated solid, as the kernel hands it over. */
export interface MeshInput {
  /** Interleaved XYZ, three floats per vertex. */
  position: Float32Array;
  /** Interleaved XYZ normals, same vertex count. Optional — glTF will flat-shade without them. */
  normal?: Float32Array;
  /** Triangle indices into the vertex arrays. */
  index: Uint32Array;
  /** Linear RGB in 0..1, from the STEP colour when it carries one. */
  color?: [number, number, number];
}

const GLB_MAGIC = 0x46546c67;      // "glTF"
const CHUNK_JSON = 0x4e4f534a;     // "JSON"
const CHUNK_BIN = 0x004e4942;      // "BIN\0"
const FLOAT = 5126;
const UINT32 = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/** Pad to a 4-byte boundary — glTF requires every chunk and buffer view to be aligned. */
function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

function bounds(position: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = position[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  // An empty mesh would otherwise emit Infinity, which is not valid JSON and not valid glTF.
  return position.length ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

/**
 * Build a `.glb` containing every mesh as its own primitive under one node.
 *
 * Kept as separate primitives rather than merged for the same reason the board keeps per-component
 * instances (ADR-038): merging is lossy, and anything that later wants to address a part — tap it,
 * colour it, hide it — would need the export redone.
 */
export function buildGlb(meshes: readonly MeshInput[]): Uint8Array {
  const views: { buffer: number; byteOffset: number; byteLength: number; target: number }[] = [];
  const accessors: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const primitives: Record<string, unknown>[] = [];
  const chunks: Uint8Array[] = [];
  let binLength = 0;

  const push = (data: ArrayBufferView, target: number): number => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    chunks.push(bytes);
    views.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength, target });
    binLength += bytes.byteLength;
    const p = pad4(binLength);
    if (p) { chunks.push(new Uint8Array(p)); binLength += p; }
    return views.length - 1;
  };

  for (const m of meshes) {
    if (!m.position.length || !m.index.length) continue;   // nothing to draw; skip rather than emit an empty primitive
    const { min, max } = bounds(m.position);

    const posView = push(m.position, ARRAY_BUFFER);
    accessors.push({ bufferView: posView, componentType: FLOAT, count: m.position.length / 3, type: "VEC3", min, max });
    const posAcc = accessors.length - 1;

    let normAcc: number | undefined;
    if (m.normal?.length === m.position.length) {
      const v = push(m.normal, ARRAY_BUFFER);
      accessors.push({ bufferView: v, componentType: FLOAT, count: m.normal.length / 3, type: "VEC3" });
      normAcc = accessors.length - 1;
    }

    const idxView = push(m.index, ELEMENT_ARRAY_BUFFER);
    accessors.push({ bufferView: idxView, componentType: UINT32, count: m.index.length, type: "SCALAR" });
    const idxAcc = accessors.length - 1;

    const attributes: Record<string, number> = { POSITION: posAcc };
    if (normAcc !== undefined) attributes["NORMAL"] = normAcc;

    const prim: Record<string, unknown> = { attributes, indices: idxAcc };
    if (m.color) {
      materials.push({
        pbrMetallicRoughness: {
          baseColorFactor: [...m.color, 1],
          metallicFactor: 0.1,
          roughnessFactor: 0.7,
        },
      });
      prim["material"] = materials.length - 1;
    }
    primitives.push(prim);
  }

  const gltf: Record<string, unknown> = {
    asset: { version: "2.0", generator: "gitview-models" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: binLength }],
  };
  if (materials.length) gltf["materials"] = materials;

  const json = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPad = pad4(json.byteLength);
  const jsonLen = json.byteLength + jsonPad;

  const total = 12 + 8 + jsonLen + (binLength ? 8 + binLength : 0);
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(GLB_MAGIC, o); o += 4;
  out.writeUInt32LE(2, o); o += 4;
  out.writeUInt32LE(total, o); o += 4;

  out.writeUInt32LE(jsonLen, o); o += 4;
  out.writeUInt32LE(CHUNK_JSON, o); o += 4;
  json.copy(out, o); o += json.byteLength;
  // JSON chunk padding is spaces, not zeroes — the spec is explicit, and a zero byte makes the chunk
  // fail to parse in strict readers.
  out.fill(0x20, o, o + jsonPad); o += jsonPad;

  if (binLength) {
    out.writeUInt32LE(binLength, o); o += 4;
    out.writeUInt32LE(CHUNK_BIN, o); o += 4;
    for (const c of chunks) { Buffer.from(c.buffer, c.byteOffset, c.byteLength).copy(out, o); o += c.byteLength; }
  }
  return new Uint8Array(out);
}

/**
 * Parse just enough of a `.glb` to say whether it is well-formed and what it holds.
 *
 * Exists so the cache can be checked rather than trusted — a truncated or corrupted blob should be
 * reported, not served to a renderer that will fail opaquely.
 */
export function inspectGlb(bytes: Uint8Array): { ok: boolean; tris: number; primitives: number; error?: string } {
  const fail = (error: string) => ({ ok: false, tris: 0, primitives: 0, error });
  if (bytes.byteLength < 20) return fail("too short");
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.readUInt32LE(0) !== GLB_MAGIC) return fail("bad magic");
  if (b.readUInt32LE(8) !== bytes.byteLength) return fail("length mismatch");
  const jsonLen = b.readUInt32LE(12);
  if (b.readUInt32LE(16) !== CHUNK_JSON) return fail("first chunk is not JSON");
  if (20 + jsonLen > bytes.byteLength) return fail("JSON chunk overruns the file");
  let gltf: { meshes?: { primitives?: { indices?: number }[] }[]; accessors?: { count?: number }[] };
  try {
    gltf = JSON.parse(b.subarray(20, 20 + jsonLen).toString("utf8"));
  } catch (e) {
    return fail(`JSON chunk unparseable: ${String(e).slice(0, 60)}`);
  }
  let tris = 0, primitives = 0;
  for (const m of gltf.meshes ?? []) {
    for (const p of m.primitives ?? []) {
      primitives += 1;
      const acc = p.indices !== undefined ? gltf.accessors?.[p.indices] : undefined;
      tris += Math.floor((acc?.count ?? 0) / 3);
    }
  }
  return { ok: true, tris, primitives };
}
