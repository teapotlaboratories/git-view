import { test } from "node:test";
import assert from "node:assert/strict";
import { projectBasename, projectPaths, projectForSheet, describeProject } from "../src/kicad/project.js";

/**
 * Resolving a path to the KiCad *project* it belongs to (ADR-040).
 *
 * Pure naming rules, kept out of the route so they can be asserted without a repo. Both of the
 * interesting ones came from measuring the corpus rather than from reasoning about the format.
 */

test("the three project files share a stem, and nothing else is a project file", () => {
  assert.deepEqual(projectBasename("hw/StickHub.kicad_pro"), { base: "hw/StickHub", name: "StickHub" });
  assert.deepEqual(projectBasename("hw/StickHub.kicad_sch"), { base: "hw/StickHub", name: "StickHub" });
  assert.deepEqual(projectBasename("hw/StickHub.kicad_pcb"), { base: "hw/StickHub", name: "StickHub" });
  // A library or a plain file must not look like half a project — the route 400s on these rather than
  // inventing siblings for them.
  assert.equal(projectBasename("hw/RobotProtos.kicad_sym"), undefined);
  assert.equal(projectBasename("README.md"), undefined);
  assert.equal(projectBasename(".kicad_pro"), undefined, "an extension with no stem names nothing");
});

test("a project at the repo root has a name and no directory", () => {
  assert.deepEqual(projectBasename("board.kicad_pcb"), { base: "board", name: "board" });
  const p = projectPaths("board");
  assert.equal(p.project, "board.kicad_pro");
  assert.equal(p.schematic, "board.kicad_sch");
  assert.equal(p.board, "board.kicad_pcb");
});

test("a sub-sheet resolves to the one project beside it", () => {
  // Basename pairing cannot reach a sub-sheet: the `video` project's seven sub-sheets are named
  // `muxdata.kicad_sch`, `pal-ntsc.kicad_sch` and so on, which pair with nothing.
  assert.deepEqual(projectForSheet(["video/video.kicad_pro"]), { project: "video/video.kicad_pro" });
});

test("two projects in one directory is a refusal, not a coin flip", () => {
  // The tempting rule — "use the .kicad_pro in this directory" — is wrong in the corpus: `ecc83/` holds
  // both `ecc83-pp.kicad_pro` and `ecc83-pp_v2.kicad_pro`. Opening the wrong project's viewer is worse
  // than offering nothing, and being sure would mean walking the sheet hierarchy, which is the parse
  // this route exists to avoid.
  assert.deepEqual(projectForSheet(["ecc83/ecc83-pp.kicad_pro", "ecc83/ecc83-pp_v2.kicad_pro"]),
    { reason: "ambiguous" });
});

test("no project file at all is its own answer", () => {
  // A design with no `.kicad_pro` is still perfectly viewable, so this must not be reported the same way
  // as an ambiguous one — the app says different things about them.
  assert.deepEqual(projectForSheet([]), { reason: "no-project-file" });
});

test("the file the client named has to exist — otherwise there is nothing to describe", () => {
  // Without this the endpoint answered questions about paths that are not there: a typo'd sheet came
  // back 200 with every field null, and — the part that makes it a defect rather than untidy — a made-up
  // sheet in `ecc83/` reported `unresolved: "ambiguous"`, volunteering a fact about that directory in
  // answer to a question about a file not in it. Found by curling a path I had invented.
  const out = describeProject({
    requested: "ecc83/ecc83-pp-rescue.kicad_sch",
    requestedExists: false,
    parts: { base: "ecc83/ecc83-pp-rescue", name: "ecc83-pp-rescue" },
    present: {},
    unresolved: "ambiguous",
  });
  assert.deepEqual(out, { missing: true }, "not an 'ambiguous' answer about a file that is not there");
});

test("a project reports only the halves it has", () => {
  // 18 of 36 corpus projects are schematic-only and 1 is board-only, so absent halves are the norm and
  // must be absent rather than null-and-present — the app builds its tabs straight off this.
  const out = describeProject({
    requested: "microwave/microwave.kicad_pcb",
    requestedExists: true,
    parts: { base: "microwave/microwave", name: "microwave" },
    present: { project: "microwave/microwave.kicad_pro", board: "microwave/microwave.kicad_pcb" },
  }) as Record<string, unknown>;
  assert.equal(out["board"], "microwave/microwave.kicad_pcb");
  assert.ok(!("schematic" in out), "a board-only project offers no schematic tab at all");
  assert.ok(!("unresolved" in out), "and it resolved fine — the absence is the project's shape, not a failure");
  assert.ok(!("sheet" in out), "the board IS the requested file, so there is no separate sheet to name");
});

test("a sub-sheet gets the WHOLE project, not its own stem's neighbours", () => {
  // The version of this test that shipped asserted only `project` and `schematic`, so it passed while
  // the endpoint was dropping the board: opening `video/muxdata.kicad_sch` looked for
  // `video/muxdata.kicad_pcb` and reported no board, while `video/video.kicad_pcb` — named by the very
  // project in the same response — sat right there. Every sub-sheet lost its PCB tab, and that is the
  // common case, not an edge one: `vme-wren` has 36 sub-sheets, `jetson` 16.
  //
  // So the assertion that matters is the board, and the sheet reported separately from the root.
  const out = describeProject({
    requested: "video/muxdata.kicad_sch",
    requestedExists: true,
    parts: { base: "video/video", name: "video" },
    present: {
      project: "video/video.kicad_pro",
      schematic: "video/video.kicad_sch",
      board: "video/video.kicad_pcb",
    },
  }) as Record<string, unknown>;
  assert.equal(out["board"], "video/video.kicad_pcb", "the project's board, which the sheet's stem never names");
  assert.equal(out["schematic"], "video/video.kicad_sch", "and its ROOT sheet");
  assert.equal(out["sheet"], "video/muxdata.kicad_sch", "with the sheet actually asked about kept separate");
  assert.equal(out["name"], "video", "named for the project, not the sheet");
});
