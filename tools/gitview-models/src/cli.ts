#!/usr/bin/env -S npx tsx
/**
 * `gitview-models` — build the mesh cache a bridge serves (ADR-038, Phase 4a).
 *
 * Separate from the bridge on purpose. This is the only component that carries OpenCascade (7.6 MB of
 * WASM, against a 4.03 MB bridge `.deb`), and the only one that ever runs a conversion. An operator who
 * does not want 3D never installs it and pays nothing.
 *
 *   gitview-models build --repo ~/hw --repo-id hw --board boards/main.kicad_pcb \
 *                        --cache /var/lib/gitview-bridge/meshes \
 *                        --model-path KICAD9_3DMODEL_DIR=/usr/share/kicad/3dmodels
 *
 * Resolution is *not* reimplemented here: it imports the bridge's own `board.ts` and `modelResolve.ts`,
 * so the set of models this converts is exactly the set the bridge reports as addressable. Two
 * implementations of that rule would drift, and the symptom would be a board reporting coverage it
 * cannot serve.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseBoard, readBoard, embeddedName, embeddedPayload } from "../../../bridge/src/kicad/board.js";
import { resolveModel } from "../../../bridge/src/kicad/modelResolve.js";
import {
  meshKey, hasBlob, putBlob, putManifest, blobPath, MESH_FORMAT_VERSION,
  type BoardManifest, type ManifestEntry,
} from "../../../bridge/src/kicad/meshCache.js";
import { inspectGlb } from "../../../bridge/src/kicad/glb.js";
import { convert, decodeEmbedded, isConvertible, kernel } from "./convert.js";

interface Args {
  repo: string; repoId: string; board: string; cache: string;
  modelPaths: Record<string, string>;
  force: boolean; maxMb: number;
}

function usage(msg?: string): never {
  if (msg) process.stderr.write(`gitview-models: ${msg}\n\n`);
  process.stderr.write(`usage: gitview-models build --repo DIR --repo-id ID --board PATH --cache DIR
                            [--model-path VAR=DIR]...  [--force] [--max-mb N]

  --repo        the git checkout the board lives in
  --repo-id     the id the bridge serves it under; manifests are keyed by it
  --board       the board, relative to --repo
  --cache       mesh cache directory, the same one the bridge is configured with
  --model-path  where a KiCad model variable points. Repeatable. One official-library name
                answers for all of them (KISYS3DMOD, KICAD6..KICAD10_3DMODEL_DIR).
  --force       reconvert even when the blob is already cached
  --max-mb      skip sources larger than this (default 32; a 25 MB STEP took 101 s and 1.7 GB)
`);
  process.exit(msg ? 2 : 0);
}

function parseArgs(argv: string[]): Args {
  if (argv[0] !== "build") usage(argv[0] ? `unknown command "${argv[0]}"` : undefined);
  const a: Args = { repo: "", repoId: "", board: "", cache: "", modelPaths: {}, force: false, maxMb: 32 };
  for (let i = 1; i < argv.length; i++) {
    const v = () => argv[++i] ?? usage(`${argv[i - 1]} needs a value`);
    switch (argv[i]) {
      case "--repo": a.repo = resolve(v()); break;
      case "--repo-id": a.repoId = v(); break;
      case "--board": a.board = v(); break;
      case "--cache": a.cache = resolve(v()); break;
      case "--force": a.force = true; break;
      case "--max-mb": a.maxMb = Number(v()); break;
      case "--model-path": {
        const [k, ...rest] = v().split("=");
        if (!k || !rest.length) usage("--model-path takes VAR=DIR");
        a.modelPaths[k] = resolve(rest.join("="));
        break;
      }
      default: usage(`unknown option "${argv[i]}"`);
    }
  }
  for (const k of ["repo", "repoId", "board", "cache"] as const) if (!a[k]) usage(`--${k} is required`);
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const boardAbs = join(args.repo, args.board);
  const text = readFileSync(boardAbs, "utf8");
  const parsed = parseBoard(text);
  const board = readBoard(parsed, new Set(Object.keys(args.modelPaths)));
  const embedded = new Set(board.models.embedded);

  process.stdout.write(
    `${basename(args.board)}: ${board.models.unique} unique models ` +
    `(${board.models.refs} references), ${embedded.size} carried in the file\n`,
  );

  // Load the kernel once, before the loop, so its ~1.2 s first-call cost is not attributed to whichever
  // model happens to be first.
  await kernel();

  const entries: ManifestEntry[] = [];
  let converted = 0, reused = 0, failed = 0, unresolved = 0, unsupported = 0, skipped = 0;

  /**
   * Write what we have and stop, on `SIGTERM`.
   *
   * The manifest is written once, after the last model — which means a run that is cut short leaves
   * every blob it converted sitting in the content-addressed cache with nothing naming them. The bridge
   * then reports `ready: 0` and the next run redoes work that is already on disk. The bridge's build
   * timeout sends `SIGTERM` before `SIGKILL` precisely so this can happen; without a handler that grace
   * period bought nothing at all.
   *
   * A partial manifest is honest: it names exactly the models that finished. The bridge's pending set is
   * computed from it, so the next build picks up the remainder rather than starting over.
   */
  let stopping = false;
  const flush = async (): Promise<void> => {
    await putManifest(args.cache, args.repoId, {
      formatVersion: MESH_FORMAT_VERSION,
      board: args.board,
      builtAt: new Date().toISOString(),
      entries,
    }).catch(() => undefined);
    process.stderr.write(`gitview-models: interrupted, wrote ${entries.length} entries\n`);
    process.exit(1);
  };
  process.on("SIGTERM", () => { if (!stopping) { stopping = true; void flush(); } });

  for (const raw of board.models.paths) {
    if (stopping) break;
    const name = embeddedName(raw);
    let source: Uint8Array | undefined;
    let why: string | undefined;

    // Two ways to get the bytes, one shared path afterwards. Keeping the cache check *after* this and
    // before `convert` is the whole economy of the tool: hashing 4 MB costs milliseconds, converting it
    // costs 19 seconds, and across a corpus most models are already done.
    if (name !== undefined) {
      if (!embedded.has(name)) why = "the board names an embedded file it does not carry";
      else if (!isConvertible(name)) why = `not a STEP file (${name})`;
      else {
        const payload = embeddedPayload(parsed.root, name);
        if (!payload) why = "embedded payload could not be read";
        // A payload that refuses to fit is recorded like any other per-model failure — one hostile or
        // broken entry must not end a build that has 65 other models to get through.
        else try { source = decodeEmbedded(payload); } catch (e) { why = String((e as Error).message).slice(0, 90); }
      }
    } else {
      const r = resolveModel(raw, { modelPaths: args.modelPaths, projectDir: dirname(boardAbs), embedded });
      if (!r.file) why = r.reason;
      else if (!isConvertible(r.file)) why = "not a STEP file";
      else {
        try { source = new Uint8Array(readFileSync(r.file)); }
        catch (e) { why = `unreadable: ${String(e).slice(0, 60)}`; }
      }
    }

    if (source && !why) {
      if (source.byteLength > args.maxMb * 1024 * 1024) {
        skipped += 1;
        entries.push({ raw, failure: "skipped",
          detail: `${(source.byteLength / 1048576).toFixed(1)} MB > --max-mb ${args.maxMb}` });
        continue;
      }
      const key = meshKey({ source });
      if (!args.force && hasBlob(args.cache, key)) {
        // Already converted, by this board or another. Re-read the blob rather than recording zeroes:
        // the manifest's triangle and byte counts are what a client uses to decide before fetching, and
        // a reused entry that claims zero would make a whole board look free to load.
        const bytes = readFileSync(blobPath(args.cache, key));
        const got = inspectGlb(new Uint8Array(bytes));
        reused += 1;
        entries.push({ raw, key, tris: got.tris, bytes: bytes.byteLength });
        continue;
      }
      const got = await convert(source);
      if (got.glb) {
        await putBlob(args.cache, key, got.glb);
        converted += 1;
        entries.push({ raw, key, tris: got.tris, bytes: got.glb.byteLength });
        continue;
      }
      why = got.error;
    }

    // Failures are recorded, never fatal: a board of vendor models will always contain some the kernel
    // cannot read, and a build that stops on the first one tells the operator nothing about the rest.
    const failure = (why === "missing" || why === "unmapped" || why === "outside-root") ? "unresolved"
      : why?.startsWith("not a STEP file") ? "unsupported-format"
      : "convert-failed";
    if (failure === "unresolved") unresolved += 1;
    else if (failure === "unsupported-format") unsupported += 1;
    else failed += 1;
    entries.push({ raw, failure, detail: why });
  }

  const manifest: BoardManifest = {
    formatVersion: MESH_FORMAT_VERSION,
    board: args.board,
    builtAt: new Date().toISOString(),
    entries,
  };
  const path = await putManifest(args.cache, args.repoId, manifest);
  const ready = entries.filter((e) => e.key).length;
  process.stdout.write(
    `  converted ${converted}, reused ${reused}, failed ${failed}, unresolved ${unresolved}, ` +
    `unsupported ${unsupported}, skipped ${skipped}\n` +
    `  ${ready}/${board.models.unique} models ready\n  manifest ${path}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`gitview-models: ${String(e)}\n`);
  process.exit(1);
});
