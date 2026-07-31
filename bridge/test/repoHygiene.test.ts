import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Repository hygiene checks that are cheap to run and expensive to discover by hand.
 *
 * **Why a NUL check exists.** A stray `\0` in a source file — easy to produce when writing a separator
 * character into a string literal — makes **git classify the file as binary**. The consequences are all
 * silent: the file shows as `Bin 0 -> 9928 bytes` in a pull request with no diff, so a reviewer cannot
 * read it at all; `grep` skips it without saying so; and editors may mangle it.
 *
 * This is here because it happened twice in one day. It was found in `src/kicad/nets.ts`, diagnosed,
 * fixed — and then reintroduced hours later in `test/kicadScene.test.ts`, which was committed as a binary
 * blob and reached a PR unreviewable. A rule that has been broken twice is worth a test rather than a
 * resolution to be more careful.
 *
 * Write separators as escapes (`"\\u0000"`), never as literal control characters.
 */

const ROOT = new URL("../..", import.meta.url).pathname;
const SCAN = ["bridge/src", "bridge/test", "bridge/tools", "android/app/src/main/java"];
const TEXT = /\.(ts|tsx|kt|kts|js|json|md|html|yaml|yml)$/;

/** Every text-ish source file under the scanned roots. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // a root that does not exist on this checkout is not a failure
    }
    for (const e of entries) {
      if (e === "node_modules" || e === "build" || e === ".git") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (TEXT.test(e)) out.push(p);
    }
  };
  for (const r of SCAN) walk(join(ROOT, r));
  return out;
}

test("no source file contains a literal NUL byte", () => {
  const files = sourceFiles();
  assert.ok(files.length > 50, `expected to scan a real tree, found ${files.length} files`);

  const offenders: string[] = [];
  for (const f of files) {
    const buf = readFileSync(f);
    const at = buf.indexOf(0);
    if (at !== -1) {
      // Report the line, because "there is a NUL somewhere in this file" is not actionable.
      const line = buf.subarray(0, at).toString("utf-8").split("\n").length;
      offenders.push(`${relative(ROOT, f)}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `literal NUL bytes make git treat these as binary — no diff in a PR, silent grep misses. ` +
      `Write "\\u0000" instead:\n  ${offenders.join("\n  ")}`,
  );
});
