import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnBuild, findConverter, resetBuilder, builderDepth, drainBuilds, pendingModels, COOLDOWN_MS,
  type Spawner,
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

const req = (board = "a.kicad_pcb") => ({
  repoPath: "/tmp/repo", repoId: "r", boardPath: board, cacheDir: "/tmp/cache", modelPaths: {},
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

test("different boards are different builds", async () => {
  const c = fakeConverter();
  spawnBuild(req("a.kicad_pcb"), c);
  spawnBuild(req("b.kicad_pcb"), c);
  assert.equal(builderDepth(), 2);
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

test("a failed spawn settles exactly once, so the concurrency cap survives it", async () => {
  // Node emits BOTH `error` and `close` when the SPAWN itself fails (EAGAIN/EMFILE on a loaded box) —
  // verified directly on this machine. `finish` was registered on each, so it ran twice: `running` was
  // decremented twice and drifted negative, after which `running < MAX_CONCURRENT` is always true and
  // the cap that bounds a 1.7 GB-RSS converter is gone for the process lifetime.
  //
  // This needs the injected spawner. The first version of this test pointed at a converter that did not
  // exist and asserted nothing real: what gets spawned is `process.execPath`, and node always exists, so
  // a missing script only makes node exit 1 and only `close` fires. Deleting the guard made no test
  // fail — which is how the useless assertion was found.
  const bothEvents: Spawner = () => ({
    once(ev, cb) { if (ev === "error" || ev === "close") setTimeout(cb, 0); return this; },
    kill() { return true; },
  });
  spawnBuild(req("boom.kicad_pcb"), "/any/converter.js", Date.now(), bothEvents);
  await drainBuilds();
  await new Promise((r) => setTimeout(r, 30));

  // If `running` went negative, the cap is broken and the second of these would NOT queue.
  const c = fakeConverter();
  const first = spawnBuild(req("x.kicad_pcb"), c);
  const second = spawnBuild(req("y.kicad_pcb"), c);
  assert.equal(first.status, "running");
  assert.equal(second.status, "queued", "the cap still holds after a failed spawn");
  await drainBuilds();
});

test("a spawner that throws outright does not wedge the builder", async () => {
  // A synchronous throw — a NUL byte in a configured path is enough. Without the try/catch the stored
  // promise rejects with nobody attached (process-fatal under Node's default) and the key stays in
  // `inflight` with `running` never decremented, so every later build queues forever.
  const throwing: Spawner = () => { throw new Error("EINVAL"); };
  spawnBuild(req("bad.kicad_pcb"), "/any/converter.js", Date.now(), throwing);
  await drainBuilds();
  await new Promise((r) => setTimeout(r, 30));
  const c = fakeConverter();
  assert.equal(spawnBuild(req("after.kicad_pcb"), c).status, "running", "the builder still works");
  await drainBuilds();
});

test("a queued build reports itself as queued, not running", async () => {
  // The app shows this. Reporting "running" for something still behind the gate says a converter is
  // working when nothing has been spawned.
  const c = fakeConverter();
  spawnBuild(req("a.kicad_pcb"), c);
  spawnBuild(req("b.kicad_pcb"), c);
  assert.equal(spawnBuild(req("b.kicad_pcb"), c).status, "queued", "asked again while still waiting");
  await drainBuilds();
});

test("the queue refuses rather than growing without bound", async () => {
  // Reachable from an authenticated client just by opening boards: without a ceiling, walking a repo's
  // boards enqueues work faster than one converter drains it, and each entry eventually spawns a process.
  const c = fakeConverter();
  for (let i = 0; i < 20; i += 1) spawnBuild(req(`b${i}.kicad_pcb`), c);
  const overflow = spawnBuild(req("one-too-many.kicad_pcb"), c);
  assert.equal(overflow.status, "busy", "refused, and nothing started for it");
  await drainBuilds();
});

const index = (paths: string[], embedded: string[] = []) => ({ models: { paths, embedded } });
const mani = (entries: Array<{ raw: string; key?: string; failure?: string }>) => ({ entries });
const LIB = { modelPaths: {}, projectDir: "/nonexistent-project-dir" };

test("a model that resolves but cannot be converted is not pending forever", () => {
  // The bug this replaced: `present + embedded - ready` never reaches zero for a `.wrl` with no STEP
  // twin, because it resolves as present while the manifest records `unsupported-format` and no key. On
  // `video` that is 24 resolvable against 23 ready, permanently — so every index request past the
  // cooldown respawned a full converter pass that could not make progress. The corpus has 18 such WRLs.
  const out = pendingModels(
    index(["kicad-embed://a.step", "kicad-embed://b.wrl"], ["a.step", "b.wrl"]),
    mani([{ raw: "kicad-embed://a.step", key: "f".repeat(64) },
           { raw: "kicad-embed://b.wrl", failure: "unsupported-format" }]),
    LIB,
  );
  assert.deepEqual(out, [], "nothing left to do, so no converter is spawned");
});

test("a model that merely could not be found is offered again once it resolves", () => {
  // `unresolved` is the one failure that is NOT deterministic: an operator who maps a variable or
  // installs the library changes the outcome. Suppressing it like the others would mean a bridge that
  // never picks up a library the operator just installed.
  const out = pendingModels(
    index(["kicad-embed://a.step"], ["a.step"]),
    mani([{ raw: "kicad-embed://a.step", failure: "unresolved" }]),
    LIB,
  );
  assert.deepEqual(out, ["kicad-embed://a.step"], "resolvable now, so worth a build");
});

test("a stale manifest entry cannot make a real model look done", () => {
  // The error ran the other way too: `ready` counted manifest entries for models the board no longer
  // references — the hidden ones this work now excludes are exactly that — which could drive the old
  // arithmetic to zero while a visible model was genuinely unbuilt.
  const out = pendingModels(
    index(["kicad-embed://new.step"], ["new.step"]),
    mani([{ raw: "kicad-embed://gone.step", key: "a".repeat(64) },
           { raw: "kicad-embed://alsogone.step", key: "b".repeat(64) }]),
    LIB,
  );
  assert.deepEqual(out, ["kicad-embed://new.step"], "the model actually on the board is still pending");
});

test("an unresolvable model is not work waiting to happen", () => {
  // An unmapped variable cannot be built by anyone, so spawning a converter to rediscover that on every
  // open would be pure noise.
  assert.deepEqual(pendingModels(index(["${NOPE}/x.step"]), undefined, LIB), []);
});
