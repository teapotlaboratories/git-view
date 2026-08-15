import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModel, resolveAll } from "../src/kicad/modelResolve.js";

/**
 * Resolving a board's 3D model references to files (ADR-038, Phase 4).
 *
 * The two rules that matter here are the extension fallback — because KiCad dropped `.wrl` in v9 while
 * boards still name it — and confinement, because these paths come out of repository content and are
 * therefore attacker-controlled.
 */

const created: string[] = [];
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }).catch(() => {}))));

/** A fake 3D library: a STEP-only one (v9+) and a project dir with a WRL, like a real machine. */
async function makeLib(): Promise<{ lib: string; proj: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), "gv-3d-"));
  created.push(base);
  const lib = join(base, "lib", "Resistor_SMD.3dshapes");
  await mkdir(lib, { recursive: true });
  await writeFile(join(lib, "R_0402_1005Metric.step"), "ISO-10303-21;\n");
  const proj = join(base, "proj", "3d");
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, "widget.wrl"), "#VRML V2.0 utf8\n");
  const outside = join(base, "secret");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "tokens.json"), "SECRET\n");
  return { lib: join(base, "lib"), proj: join(base, "proj"), outside };
}

test("a .wrl reference resolves to its .step twin — the v9+ case", async () => {
  // Measured against the real library: 0 of 20 `.wrl` references resolve as written on a v9+ install,
  // while 19 of 20 have a `.step` twin at the same basename. Without this rule, everyone on a current
  // KiCad sees nothing at all.
  const { lib } = await makeLib();
  const r = resolveModel("${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.ok(r.file, "resolved");
  assert.ok(r.file!.endsWith(".step"), `found the twin, got ${r.file}`);
  assert.equal(r.viaTwin, true, "and says it was a twin rather than pretending it was the named file");
});

test("a STEP twin beats a .wrl that is actually there", async () => {
  // This asserted the opposite until it was measured. "The reference is the better signal about which
  // one the author meant" sounds right and is wrong here: only STEP can be converted, so preferring the
  // named `.wrl` resolves a model that then fails as `unsupported-format`. On `video.kicad_pcb` against
  // the KiCad 7 library — which ships `.wrl` beside `.step` — that was 170 references, 24 resolved
  // present and **0 convertible**. `present` has to mean renderable or it is not worth counting.
  const { lib } = await makeLib();
  await writeFile(join(lib, "Resistor_SMD.3dshapes", "R_0402_1005Metric.wrl"), "#VRML V2.0 utf8\n");
  const r = resolveModel("${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.ok(r.file!.endsWith(".step"), `should prefer the convertible twin, got ${r.file}`);
  assert.equal(r.viaTwin, true, "and says so, rather than pretending it was the named file");
});

test("a .wrl is still used when no STEP twin exists", async () => {
  // The preference is not a ban. A library that ships only `.wrl` should still resolve — the model is
  // reported present and the conversion step is where it is refused, which keeps "cannot find it" and
  // "cannot read it" as separate answers.
  const { lib } = await makeLib();
  const dir = join(lib, "Wrl_Only.3dshapes");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Thing.wrl"), "#VRML V2.0 utf8\n");
  const r = resolveModel("${KICAD9_3DMODEL_DIR}/Wrl_Only.3dshapes/Thing.wrl",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.ok(r.file!.endsWith(".wrl"), `should fall back to the named file, got ${r.file}`);
  assert.ok(!r.viaTwin, "it IS the named file, so not a twin");
});

test("a .step reference prefers its .stp twin over a .wrl — the same bug, mirrored", async () => {
  // `TWINS[".step"]` listed only `.wrl`, so the two STEP spellings were not twins of each other and the
  // fix for `.wrl` references left this direction broken: the non-convertible `.wrl` won and the
  // convertible `.stp` beside it was never probed. 28 `.stp` references in the corpus.
  const { lib } = await makeLib();
  const dir = join(lib, "Mirror.3dshapes");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "P.stp"), "ISO-10303-21;\n");
  await writeFile(join(dir, "P.wrl"), "#VRML V2.0 utf8\n");
  const r = resolveModel("${KICAD9_3DMODEL_DIR}/Mirror.3dshapes/P.step",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.ok(r.file!.endsWith(".stp"), `should take the convertible spelling, got ${r.file}`);
});

test("an UPPERCASE extension resolves to the file it names", async () => {
  // `splitExt` lowercased the extension and every candidate was rebuilt from it, so `Part.STEP` looked
  // only for `Part.step` — a different file on any case-sensitive filesystem, i.e. every Linux bridge.
  // The corpus has 22 `.STEP` references, all of them project-local models committed beside their board.
  const { lib } = await makeLib();
  const dir = join(lib, "Shouty.3dshapes");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Q.STEP"), "ISO-10303-21;\n");
  const r = resolveModel("${KICAD9_3DMODEL_DIR}/Shouty.3dshapes/Q.STEP",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.ok(r.file, `should resolve as written, got reason=${r.reason}`);
  assert.ok(r.file!.endsWith("Q.STEP"), `and be the file the board named, got ${r.file}`);
  assert.ok(!r.viaTwin, "it IS the named file");
});

test("a case-only match is not counted as a twin", async () => {
  // `viaTwin` is surfaced to the app, so it has to mean "we substituted a file". `Part.STEP` answered by
  // `Part.step` is the same part in the same format — on a case-insensitive filesystem, the same inode —
  // and counting it inflates a number a person reads.
  const { lib } = await makeLib();
  const dir = join(lib, "CaseOnly.3dshapes");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "T.step"), "ISO-10303-21;\n");
  const r = resolveModel("${KICAD9_3DMODEL_DIR}/CaseOnly.3dshapes/T.STEP",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.ok(r.file!.endsWith("T.step"), `should find the lowercase file, got ${r.file}`);
  assert.ok(!r.viaTwin, "same part, same format — not a substitution");
});

test("an escaping twin is skipped, not fatal — the good file beside it still wins", async () => {
  // Probing the twin first means a symlinked-out `.step` is reached before the honest `.wrl`. Returning
  // on the first refusal hid that `.wrl` and reported `outside-root`, which says the *board* pointed out
  // of its mapped directory — and the board's reference (`R.wrl`) never left it.
  const { lib, outside } = await makeLib();
  const dir = join(lib, "Sneaky.3dshapes");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "R.wrl"), "#VRML V2.0 utf8\n");
  await symlink(join(outside, "tokens.json"), join(dir, "R.step"));
  const r = resolveModel("${KICAD9_3DMODEL_DIR}/Sneaky.3dshapes/R.wrl",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.ok(r.file, `should fall through to the in-root file, got reason=${r.reason}`);
  assert.ok(r.file!.endsWith("R.wrl"), `and it is the honest one, got ${r.file}`);
});

test("outside-root is still reported when the escape is the only thing there", async () => {
  // The counterpart to the test above: skipping a refused candidate must not downgrade a genuine escape
  // to a plain "missing", which would conflate someone climbing out with a file simply not installed.
  const { lib, outside } = await makeLib();
  const dir = join(lib, "OnlyEvil.3dshapes");
  await mkdir(dir, { recursive: true });
  await symlink(join(outside, "tokens.json"), join(dir, "S.step"));
  const r = resolveModel("${KICAD9_3DMODEL_DIR}/OnlyEvil.3dshapes/S.step",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.equal(r.file, undefined, "nothing is handed over");
  assert.equal(r.reason, "outside-root", "and it says why, rather than 'missing'");
});

test("an unmapped variable is reported, not guessed at", async () => {
  // ${ANT3DMDL} is 1,007 references across the corpus to somebody's private library. Inventing a
  // location for it would be worse than saying we have none.
  const r = resolveModel("${ANT3DMDL}/BGA.step", { modelPaths: {} });
  assert.equal(r.file, undefined);
  assert.equal(r.reason, "unmapped");
  assert.equal(r.variable, "ANT3DMDL", "names what an operator would need to map");
});

test("${KIPRJMOD} and relative paths resolve against the board's own directory", async () => {
  const { proj } = await makeLib();
  for (const raw of ["${KIPRJMOD}/3d/widget.wrl", "3d/widget.wrl"]) {
    const r = resolveModel(raw, { modelPaths: {}, projectDir: proj });
    assert.ok(r.file, `${raw} should resolve from the repo alone`);
    assert.equal(r.origin, "project");
  }
});

test("a reference that climbs out of its mapped directory is refused", async () => {
  // Model paths come from repository content. `${VAR}/../../secret/tokens.json` is a model reference like
  // any other, and must not become a way to read the host.
  const { lib, outside } = await makeLib();
  const r = resolveModel("${KICAD9_3DMODEL_DIR}/../secret/tokens.json",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.equal(r.file, undefined, "must not resolve");
  assert.equal(r.reason, "outside-root", "and must be distinguishable from a plain miss");
  assert.ok(!JSON.stringify(r).includes(outside), "and must not echo the path it refused");
});

test("a symlink out of the mapped directory is refused too", async () => {
  // Confining on the textual path alone would miss this: the path stays inside, the file does not.
  const { lib, outside } = await makeLib();
  await symlink(outside, join(lib, "escape")).catch(() => {});
  const r = resolveModel("${KICAD9_3DMODEL_DIR}/escape/tokens.json",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.notEqual(r.reason, undefined, "must not resolve through the link");
  assert.equal(r.file, undefined);
});

test("a traversal is refused even when nothing is there to find", async () => {
  // The escape and the *report* are separate rules. A probe at a path that happens not to exist must
  // still come back "outside-root": reporting it as "missing" would tell whoever is probing that the
  // path was accepted and merely empty, which is a directory oracle. Only checking confinement on files
  // that exist looks correct — the test above passes either way, because its target does exist.
  const { lib } = await makeLib();
  const r = resolveModel("${KICAD9_3DMODEL_DIR}/../secret/no-such-file.step",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.equal(r.file, undefined);
  assert.equal(r.reason, "outside-root", "refused for climbing out, not merely absent");
});

test("an absolute reference is never probed on this host", async () => {
  // The finding this test exists for. Model references come from repository content, so calling
  // `existsSync` on an attacker-supplied absolute path turns coverage into an existence oracle: the
  // board index publishes `present` vs `missing`, that is one bit per reference about the host
  // filesystem, and a board may carry as many references as it likes.
  //
  // The proof is a path that DOES exist: if the answer still refuses to depend on the filesystem, no
  // information can leak through it.
  const { lib } = await makeLib();
  const real = join(lib, "Resistor_SMD.3dshapes", "R_0402_1005Metric.step");
  assert.ok(existsSync(real), "fixture precondition — this file is really there");

  const r = resolveModel(real, { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.equal(r.file, undefined, "an existing file must NOT be reported as resolved");
  assert.equal(r.reason, "unmapped", "and must read the same as a path we have no mapping for");
  assert.equal(r.origin, "absolute", "while still saying how it was addressed");

  // A path that does not exist must be indistinguishable from the one that does.
  const missing = resolveModel("/definitely/not/here/part.step", { modelPaths: {} });
  assert.deepEqual(
    { file: missing.file, reason: missing.reason },
    { file: r.file, reason: r.reason },
    "existing and absent absolute paths must answer identically, or the difference is the oracle",
  );
});

test("a mapped-but-absent model is 'missing', which is not the same as 'unmapped'", async () => {
  // One means the operator has told us where to look and it is not there; the other means they have not
  // told us. Only the second is fixed by configuration, so the UI must be able to tell them apart.
  const { lib } = await makeLib();
  const r = resolveModel("${KICAD9_3DMODEL_DIR}/Nope.3dshapes/Nothing.step",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.equal(r.reason, "missing");
});

test("one mapped official-library name answers for all six", async () => {
  // ${KISYS3DMOD} is the pre-v6 name; v6 onward numbers it per generation. They are the same library,
  // so mapping one must not leave the others unresolved — that is five silent coverage losses for a
  // config the operator would reasonably think complete.
  const { lib } = await makeLib();
  for (const v of ["KISYS3DMOD", "KICAD6_3DMODEL_DIR", "KICAD8_3DMODEL_DIR", "KICAD10_3DMODEL_DIR"]) {
    const r = resolveModel(`\${${v}}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl`,
      { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
    assert.ok(r.file, `\${${v}} should resolve against the one mapped official library`);
    assert.equal(r.origin, "configured", "and count as configured, not unmapped");
  }
});

test("a mapped variable resolves through its own mapping, official or not", async () => {
  // The plain case, and it had no test: an operator maps their private library and it works. Worth
  // pinning because the alias rule sits in front of this path — a fallback that forgot to honour the
  // exact mapping first would break every non-official variable while all the alias tests stayed green.
  const { lib } = await makeLib();
  const r = resolveModel("${ANT3DMDL}/Resistor_SMD.3dshapes/R_0402_1005Metric.step",
    { modelPaths: { ANT3DMDL: lib } });
  assert.ok(r.file, "a mapped private library resolves");
  assert.equal(r.origin, "configured");
});

test("the exact mapping wins over the alias, and the alias prefers the newest", async () => {
  // Two official generations mapped to different directories. Naming one must use *that* one; naming a
  // third, unmapped generation must fall back to the newest, since a v10 library is likeliest to still
  // carry the part.
  const { lib } = await makeLib();
  const old = await mkdtemp(join(tmpdir(), "gv-3d-old-"));
  created.push(old);
  await mkdir(join(old, "Resistor_SMD.3dshapes"), { recursive: true });
  await writeFile(join(old, "Resistor_SMD.3dshapes", "R_0402_1005Metric.step"), "ISO-10303-21;\n");
  const paths = { KICAD6_3DMODEL_DIR: old, KICAD10_3DMODEL_DIR: lib };
  const rel = "Resistor_SMD.3dshapes/R_0402_1005Metric.step";

  const exact = resolveModel(`\${KICAD6_3DMODEL_DIR}/${rel}`, { modelPaths: paths });
  assert.ok(exact.file!.startsWith(old), `named v6 must use the v6 mapping, got ${exact.file}`);

  const aliased = resolveModel(`\${KICAD8_3DMODEL_DIR}/${rel}`, { modelPaths: paths });
  assert.ok(aliased.file!.startsWith(lib), `unmapped v8 must fall back to the newest, got ${aliased.file}`);
});

test("the alias never reaches outside the official library", async () => {
  // The rule is "these are all names for one library", not "try any directory we have". ${ANT3DMDL} is
  // somebody's private library: resolving it against the official one would hand back a part with the
  // right filename and the wrong geometry, which is worse than reporting nothing.
  const { lib } = await makeLib();
  const r = resolveModel("${ANT3DMDL}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.equal(r.file, undefined, "must not borrow the official library's directory");
  assert.equal(r.reason, "unmapped");
});

test("an aliased root is confined like any other", async () => {
  // The fallback picks the *root*; it must not pick a different confinement boundary along with it.
  const { lib, outside } = await makeLib();
  const r = resolveModel("${KISYS3DMOD}/../secret/tokens.json",
    { modelPaths: { KICAD9_3DMODEL_DIR: lib } });
  assert.equal(r.file, undefined);
  assert.equal(r.reason, "outside-root");
  assert.ok(!JSON.stringify(r).includes(outside));
});

test("a model the board carries itself resolves without touching the disk", async () => {
  // KiCad 9 embeds models in the .kicad_pcb. This used to fall through to the relative-path branch,
  // look for a file that was never on disk, and report `missing` — on `vme-wren`, 33 of its 66 unique
  // models, from a file that contains every one of them.
  const r = resolveModel("kicad-embed://5000751517.step",
    { modelPaths: {}, embedded: new Set(["5000751517.step"]) });
  assert.equal(r.embedded, true, "available, and from the board itself");
  assert.equal(r.reason, undefined, "so not a failure of any kind");
  assert.equal(r.file, undefined, "and there is no host path — the bytes are in the board");
  assert.equal(r.origin, "embedded", "its own origin: neither project nor configured");
});

test("an embedded reference with no payload is missing, not available", async () => {
  // The board names something it does not carry. Declarations and payloads are different things:
  // `vme-wren` has 155 per-footprint declarations against 33 actual payloads, so believing the
  // declaration would claim models the file does not have.
  const r = resolveModel("kicad-embed://not-carried.step", { modelPaths: {}, embedded: new Set() });
  assert.equal(r.embedded, undefined);
  assert.equal(r.reason, "missing");
});

test("an embedded reference is never looked up on disk", async () => {
  // Confinement's counterpart: the scheme is not a path, so `kicad-embed://../../secret` must not be
  // resolved against anything. It is a name, matched exactly against what the board carries.
  const { outside } = await makeLib();
  const r = resolveModel("kicad-embed://../../secret/tokens.json",
    { modelPaths: {}, projectDir: outside, embedded: new Set(["tokens.json"]) });
  assert.equal(r.file, undefined, "no filesystem lookup happens at all");
  assert.equal(r.embedded, undefined, "and the name does not match what is carried");
  assert.equal(r.reason, "missing");
});

test("resolveAll summarises a board's references", async () => {
  const { lib, proj } = await makeLib();
  const cov = resolveAll([
    "${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl",  // via twin
    "${KIPRJMOD}/3d/widget.wrl",                                          // present as named
    "${ANT3DMDL}/BGA.step",                                               // unmapped
    "${KICAD9_3DMODEL_DIR}/Nope.3dshapes/X.step",                         // missing
    "${KICAD9_3DMODEL_DIR}/../secret/tokens.json",                        // refused
    "kicad-embed://part.step",                                            // carried by the board
  ], { modelPaths: { KICAD9_3DMODEL_DIR: lib }, projectDir: proj, embedded: new Set(["part.step"]) });
  assert.equal(cov.present, 2);
  assert.equal(cov.embedded, 1, "counted apart from present — it needs no host file at all");
  assert.equal(cov.viaTwin, 1, "counted within present, and reported separately");
  assert.equal(cov.unmapped, 1);
  assert.equal(cov.missing, 1);
  assert.equal(cov.outsideRoot, 1);
});
