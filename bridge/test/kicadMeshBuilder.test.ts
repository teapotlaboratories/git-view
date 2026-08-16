import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnBuild, findConverter, resetBuilder, builderDepth, drainBuilds, COOLDOWN_MS,
} from "../src/kicad/meshBuilder.js";

/**
 * The bounds on on-demand conversion (ADR-040 Decision 5).
 *
 * The conversion itself is a separate program and is not what these assert — what matters here is
 * everything that stops a board being converted twice, converted again a second after it finished, or
 * converted at all on a bridge with no converter. Those are the rules that make reversing an
 * ahead-of-time pipeline safe, so they are the ones with tests.
 */

/** A converter that exists and exits immediately, so a "build" is real but instant. */
function fakeConverter(): string {
  const dir = mkdtempSync(join(tmpdir(), "gv-conv-"));
  const p = join(dir, "cli.js");
  writeFileSync(p, "process.exit(0);\n");
  return p;
}

const req = (board = "a.kicad_pcb", ref = "abc123") => ({
  repoPath: "/tmp/repo", repoId: "r", boardPath: board, cacheDir: "/tmp/cache",
  modelPaths: {}, ref,
});

beforeEach(() => resetBuilder());

test("a bridge with no converter says so, and starts nothing", () => {
  // The ordinary state of every packaged bridge until the .deb ships one. It must be a reported state,
  // not an error and not a silent no-op — the app tells the user why 3D is empty.
  const s = spawnBuild(req(), undefined);
  assert.equal(s.status, "unavailable");
  assert.equal(builderDepth(), 0, "and nothing is queued behind it");
});

test("two requests for the same board share one build", async () => {
  // Two devices opening the same board, or one device refreshing. Without this the second spawns a
  // duplicate converter over the same 66 models — the expensive moment is exactly when nobody has it
  // cached yet, which is when a collision is most likely.
  const c = fakeConverter();
  const first = spawnBuild(req(), c);
  const second = spawnBuild(req(), c);
  assert.equal(first.status, "running");
  assert.equal(second.status, "running", "joins the running one");
  assert.equal(builderDepth(), 1, "one build, not two");
  await drainBuilds();
});

test("different boards, and the same board at different refs, are different builds", async () => {
  // The ref is part of the identity because a build for an older commit is not a build for HEAD; the
  // manifest it writes describes a specific board's contents.
  const c = fakeConverter();
  spawnBuild(req("a.kicad_pcb", "ref1"), c);
  spawnBuild(req("b.kicad_pcb", "ref1"), c);
  spawnBuild(req("a.kicad_pcb", "ref2"), c);
  assert.equal(builderDepth(), 3);
  await drainBuilds();
});

test("the second and third boards queue rather than all running at once", async () => {
  // The converter is CPU- and memory-hungry (1.7 GB of RSS on one 25 MB model) and a bridge is often
  // somebody's spare machine, so concurrency is capped and the rest wait.
  const c = fakeConverter();
  const a = spawnBuild(req("a.kicad_pcb"), c);
  const b = spawnBuild(req("b.kicad_pcb"), c);
  assert.equal(a.status, "running");
  assert.equal(b.status, "queued", "capped, not run in parallel");
  await drainBuilds();
});

test("a board that just finished is not rebuilt immediately", async () => {
  // Open, close, reopen. A full pass over an already-converted board still costs a parse and a hash per
  // model, so a cooldown keeps a flicking user from respawning it.
  const c = fakeConverter();
  spawnBuild(req(), c);
  await drainBuilds();
  assert.equal(spawnBuild(req(), c).status, "cooling");
});

test("after the cooldown it may build again", async () => {
  // The cooldown is a damper, not a latch — a board whose models changed has to be reconvertible.
  const c = fakeConverter();
  spawnBuild(req(), c);
  await drainBuilds();
  const later = Date.now() + COOLDOWN_MS + 1;
  assert.equal(spawnBuild(req(), c, later).status, "running");
  await drainBuilds();
});

test("a configured converter that is not there is treated as absent", () => {
  // A typo in `kicad.converter` must degrade to "this bridge does not convert", not to spawning a path
  // that does not exist and reporting a build that can never finish.
  assert.equal(findConverter("/nonexistent/cli.js"), undefined);
  const c = fakeConverter();
  assert.equal(findConverter(c), c, "and a real one is taken as given");
});
