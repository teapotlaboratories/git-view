import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeEmbedded, MAX_EMBEDDED_BYTES, EmbeddedTooLarge } from "../src/convert.js";

/**
 * Bounding an embedded payload while it decompresses (ADR-038, Phase 4a).
 *
 * A `.kicad_pcb` is repository content, and KiCad 9 lets it carry zstd-compressed files. The `--max-mb`
 * check in the CLI caps what gets *converted* — a check on the result, by which time a small payload that
 * expands without bound has already been allocated. So the budget belongs inside the decompression.
 *
 * The fixture is a real bomb rather than an imagined one: 6,460 bytes of `zstd -19` that expand to
 * 200 MB, a ratio of 32,463:1. Regenerate with `head -c 209715200 /dev/zero | zstd -19 -o zstd-bomb.zst`.
 */

const BOMB = readFileSync(join(import.meta.dirname, "fixtures", "zstd-bomb.zst")).toString("base64");

test("a decompression bomb is refused mid-stream, not after it has expanded", () => {
  // The limit is set well below the payload so it is reached long before the end. If the budget were
  // checked *after* decompressing, this would still pass — having allocated 200 MB to do so.
  assert.throws(() => decodeEmbedded(BOMB, 8 * 1024 * 1024), EmbeddedTooLarge);
});

test("the default ceiling refuses it too", () => {
  assert.throws(() => decodeEmbedded(BOMB), EmbeddedTooLarge);
  assert.ok(MAX_EMBEDDED_BYTES < 200 * 1024 * 1024, "the ceiling must actually be below the bomb");
});

test("an ordinary payload still decodes", () => {
  // The rule must not simply refuse everything.
  const plain = Buffer.from("ISO-10303-21;\nHEADER;\n").toString("base64");
  assert.equal(Buffer.from(decodeEmbedded(plain)).toString("utf8").slice(0, 13), "ISO-10303-21;");
});

test("an oversized uncompressed payload is refused as well", () => {
  // Otherwise the ceiling is bypassed by simply not compressing.
  const big = Buffer.alloc(1024 * 1024, 0x41).toString("base64");
  assert.throws(() => decodeEmbedded(big, 1024), EmbeddedTooLarge);
});
