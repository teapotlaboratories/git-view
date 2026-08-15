/**
 * Turning a board's 3D model reference into a file on this host (ADR-038, Phase 4).
 *
 * Two things make this more than string concatenation.
 *
 * **The extension in the reference is often wrong now.** KiCad shipped both `.wrl` and `.step` through
 * v8 and dropped `.wrl` in v9 — checked against the library's own `install()` rules, which match
 * `"*.wrl"` and `"*.step"` at 6.0.11/7.0.11/8.0.8 and only `"*.step"` at 9.0.9/10.0.5. Boards authored
 * against the older library still *name* `.wrl`, so on a v9+ install those references resolve to
 * nothing: measured, **0 of 20** resolved as written, while **19 of 20** had a `.step` twin at the same
 * basename. So resolution is by basename rather than by the extension the board happens to name.
 *
 * On a v6–v8 install the opposite trap appears: the `.wrl` *is* there, resolves as named, and then cannot
 * be converted. Measured on `video.kicad_pcb` against the v7 library — 175 references over 27 unique
 * models, all `.wrl` — **24 of the 27 resolved and 0 converted**. So a STEP twin is preferred even when
 * the named `.wrl` exists; see [TWINS].
 *
 * That single rule is also why STEP-only is enough. Every library version ships `.step` — the old ones
 * ship it *alongside* `.wrl` — so a reader that understands STEP covers v6 through v10, and WRL support
 * would only duplicate coverage on old installs while adding nothing on new ones.
 *
 * **Some models are not on disk at all.** KiCad 9 can embed a model *inside* the board file, and the
 * reference is then a URI — `kicad-embed://part.step` — resolved against the file's own payloads rather
 * than any directory. It is the cheapest case there is (no download, no operator configuration), and
 * treating it as a relative path fails in the worst direction: it reports a model missing from a board
 * that is carrying it. On `vme-wren` that is **33 of 66** unique models.
 *
 * **The paths come out of repository content, so they are attacker-controlled.** `${VAR}/../../etc/passwd`
 * is a model reference like any other. Every resolved path is confined to the directory it was mapped
 * into, and a reference that escapes is reported as unresolved rather than followed.
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve as resolvePath, sep } from "node:path";
import { classifyModel, embeddedName, libVarFor, type ModelOrigin } from "./board.js";

/**
 * The formats a model may be stored as, in preference order.
 *
 * A `.wrl` reference prefers its **STEP twin even when the `.wrl` itself is present**, which is not the
 * obvious ordering and is the whole point. Only STEP can be converted; a `.wrl` resolves happily and then
 * fails at conversion as `unsupported-format`, so preferring it produces coverage that counts models the
 * pipeline can never render — `present` that does not mean renderable.
 *
 * Measured: `video.kicad_pcb` carries **175 model references over 27 unique models**, every one of them
 * named `.wrl`, and the KiCad 7 library ships `.wrl` *beside* `.step`. Named-first resolution resolved
 * **24 of the 27** and converted **none** of them. Every library version ships `.step` (the older ones
 * alongside `.wrl`), so preferring it is never worse, and the `.wrl` stays as a last resort for a library
 * that somehow ships only that.
 *
 * The two STEP spellings are twins of **each other**, not only of `.wrl`. Listing just `.wrl` under
 * `.step` reproduced the very bug above in the mirror direction: a `.step` reference beside a `P.stp` and
 * a `P.wrl` resolved to the `.wrl` and failed conversion, while the convertible `.stp` was never probed.
 * The corpus has 28 `.stp` references, so that is a real population, not a hypothetical one.
 */
const TWINS: Record<string, string[]> = {
  ".wrl": [".step", ".stp"],
  ".step": [".stp", ".wrl"],
  ".stp": [".step", ".wrl"],
};

/**
 * Extensions the mesh pipeline can actually convert — see [TWINS].
 *
 * Exported because `gitview-models` decides the same question when it reaches the file, and two
 * independent lists drift silently: adding a format to the converter while this stayed behind would leave
 * the new format probed *after* a `.wrl`, which is exactly the bug this module exists to prevent, with
 * nothing failing to announce it.
 */
export const CONVERTIBLE_EXTS: ReadonlySet<string> = new Set([".step", ".stp"]);

export interface ResolvedModel {
  raw: string;
  origin: ModelOrigin;
  variable?: string;
  /** Absolute path on this host, when one was found. */
  file?: string;
  /** True when the file was found under a *different* extension than the reference named. */
  viaTwin?: boolean;
  /**
   * True when the board carries the model itself. There is no `file`: the bytes are in the `.kicad_pcb`,
   * so anything that wants them reads the board rather than the filesystem.
   */
  embedded?: boolean;
  /** Why it could not be resolved, when it could not. */
  reason?: "unmapped" | "missing" | "outside-root";
}

export interface ResolveOptions {
  /** Variable name → directory on this host, from `config.kicad.modelPaths`. */
  modelPaths: Readonly<Record<string, string>>;
  /** Absolute directory of the board being read — resolves `${KIPRJMOD}` and relative references. */
  projectDir?: string;
  /**
   * Names the board carries a payload for, from `Board.models.embedded`.
   *
   * Passed in rather than read here for the same reason the rest of this module takes a mapping: the
   * reader knows the file's contents, this knows how to resolve a reference, and neither needs the
   * other's job.
   */
  embedded?: ReadonlySet<string>;
}

/**
 * Split a path into its directory+stem and its extension **as written**.
 *
 * The extension is deliberately *not* lowercased here. It used to be, and that silently made an uppercase
 * reference unresolvable: every candidate was rebuilt as `stem + lowercasedExt`, so a board naming
 * `Part.STEP` looked for `Part.step`, which on any case-sensitive filesystem — i.e. every Linux bridge —
 * is a different file. The corpus has **22 `.STEP` references**. Callers lowercase it themselves for the
 * one thing that genuinely wants a case-insensitive key: the [TWINS] / [CONVERTIBLE_EXTS] lookup.
 */
function splitExt(p: string): [string, string] {
  const i = p.lastIndexOf(".");
  const j = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i <= j) return [p, ""];
  return [p.slice(0, i), p.slice(i)];
}

/** Is `candidate` under `root` as written? No syscall, so it is also valid for a path that is not there. */
function containedTextually(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Is `candidate` still under `root` *after* following symlinks?
 *
 * Checked separately from the textual test, and only for a file that exists, because that is the only
 * case where the two can disagree — and because `realpathSync` on an absent path throws, which is by far
 * the most expensive thing this module can do. Resolving `vme-wren`'s 66 models spent **21.5 ms** almost
 * entirely on constructing and catching ENOENT for candidates that were never going to be there; not
 * calling it for those is what takes this to 1.2 ms.
 */
function containedReally(rootReal: string, candidate: string): boolean {
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    // It existed a moment ago and will not resolve now — realistically a race with a delete, since
    // `existsSync` resolves the same path the same way and would already have said no. Fail closed: we
    // cannot show it is safe, so we do not hand it over.
    //
    // Deliberately not test-covered, and flagged rather than left looking covered: setting this up means
    // winning a race between two syscalls, and a test that cannot fail is worse than an absent one.
    return false;
  }
  return containedTextually(rootReal, real);
}

/**
 * Resolve one model reference to a file on this host, or explain why not.
 *
 * Never throws: an unresolvable reference is a *reported* state, because "this board has 66 models we
 * cannot find" is the answer worth having rather than an error to swallow.
 */
export function resolveModel(raw: string, opts: ResolveOptions): ResolvedModel {
  const exists = existsSync;
  const info = classifyModel(raw, new Set(Object.keys(opts.modelPaths)));
  const norm = raw.replace(/\\/g, "/");

  // A model the board carries itself. Answered before anything touches the filesystem, because there is
  // no path to look up — treating it as one is what reported 33 of `vme-wren`'s 66 models as missing
  // from a file that contains them. A reference whose payload is absent is genuinely missing: the board
  // names something it does not carry.
  const embed = embeddedName(raw);
  if (embed !== undefined) {
    return opts.embedded?.has(embed)
      ? { ...info, raw, embedded: true }
      : { ...info, raw, reason: "missing" };
  }

  // Where does this reference's root live on disk?
  let root: string | undefined;
  let rest: string;
  const varMatch = /^\$\{([^}]+)\}\/?(.*)$/.exec(norm);
  if (varMatch) {
    const [, variable, tail] = varMatch;
    rest = tail ?? "";
    // Not `modelPaths[variable]` directly: the official library has had six names across versions and
    // one mapping answers for all of them. See [libVarFor].
    const mapped = libVarFor(variable!, new Set(Object.keys(opts.modelPaths)));
    root = variable === "KIPRJMOD" ? opts.projectDir : (mapped ? opts.modelPaths[mapped] : undefined);
  } else if (isAbsolute(norm)) {
    // An absolute path from someone else's machine. Reported, never probed — see below.
    root = undefined;
    rest = norm;
  } else {
    root = opts.projectDir;
    rest = norm;
  }

  // An absolute reference is answered WITHOUT touching the filesystem.
  //
  // Model references come from repository content, which is why every mapped path above is confined. An
  // absolute path has nothing to confine it to, so calling `exists` on it would turn coverage into an
  // existence oracle for the host: a board carrying `(model "/home/x/.ssh/id_ed25519")` learns one bit
  // from `present` vs `missing`, and a board may carry as many references as it likes. The path is never
  // echoed back, but the count is enough.
  //
  // Reporting `unmapped` loses nothing real. All 8 absolute references in the corpus point at other
  // people's machines and resolve to nothing here, and "a path we have no mapping for" is exactly what
  // they are. `origin` still says `absolute`, so a client can tell the two apart.
  if (!varMatch && isAbsolute(norm)) return { ...info, raw, reason: "unmapped" };
  if (!root) return { ...info, raw, reason: "unmapped" };

  const rootResolved = resolvePath(root);
  const [stem, extRaw] = splitExt(resolvePath(root, rest));
  // `named` keeps the case the board wrote; `ext` is the lowercase key for the tables. Conflating the two
  // is what made `Part.STEP` unresolvable — see [splitExt].
  const named = stem + extRaw;
  const ext = extRaw.toLowerCase();
  // A convertible twin outranks a non-convertible named file; otherwise the named one leads. See [TWINS].
  const twins = (TWINS[ext] ?? []).map((e) => stem + e);
  // The lowercase spelling of the reference is tried too, for a board that shouts `.STEP` at a library
  // that ships `.step`. Only that one variant, not a case permutation of every twin: the measured cases
  // are references in unusual case pointing at conventionally-named files, and probing the full cross
  // product would multiply the syscalls this module works hard to avoid.
  const ordered = CONVERTIBLE_EXTS.has(ext)
    ? [named, stem + ext, ...twins]
    : [...twins, named, stem + ext];
  const candidates = [...new Set(ordered)];

  // Textual confinement first, and once: it needs no syscall, it is what catches `../..` traversal, and
  // it holds whether or not the target exists — so a probe is never reported as a plain "missing", which
  // would conflate someone climbing out with a file simply not being installed. Checking `candidates[0]`
  // covers all of them: the twins differ only in extension, so they share its directory.
  if (!containedTextually(rootResolved, candidates[0]!)) return { ...info, raw, reason: "outside-root" };

  let rootReal: string | undefined;
  // A candidate refused for escaping the root does not end the search — it skips that candidate. Once a
  // twin is probed *before* the named file, returning here let a symlinked-out `.step` mask a perfectly
  // good `.wrl` sitting beside it, and then reported `outside-root`, which tells the operator the board
  // pointed outside its mapped directory when the board's own reference never left it. So: refusal is
  // remembered, the search continues, and it is only the answer when nothing in-root was found.
  let refused = false;
  for (const c of candidates) {
    if (!exists(c)) continue;
    rootReal ??= (() => { try { return realpathSync(rootResolved); } catch { return rootResolved; } })();
    // Only now, for a file that is actually there, is it worth following symlinks.
    if (!containedReally(rootReal, c)) { refused = true; continue; }
    // Against the NAMED path, not candidates[0] — those now differ when a twin outranks the
    // name, and `viaTwin` means "not the file the board asked for", which is what a client shows.
    return { ...info, raw, file: c, viaTwin: c !== named };
  }
  return { ...info, raw, reason: refused ? "outside-root" : "missing" };
}

export interface ResolvedCoverage {
  /** Found on this host, as named. */
  present: number;
  /** Carried inside the board file — needs neither a download nor operator configuration. */
  embedded: number;
  /**
   * Found, but not under the name the board wrote.
   *
   * **Not a version signal**, though it was described as "the v9+ case" when the twin was only a
   * fallback. Now that a convertible twin outranks a present `.wrl`, a **v6–v8** install reports this for
   * essentially every official-library model — the opposite install to the one the old wording named.
   * It means "we substituted a file", nothing more.
   */
  viaTwin: number;
  /** Mapped, but the file is not here. */
  missing: number;
  /** No mapping for the variable; nothing can be looked for. */
  unmapped: number;
  /** Refused: the reference pointed outside its mapped directory. */
  outsideRoot: number;
}

/** Resolve every unique reference on a board and summarise. */
export function resolveAll(paths: readonly string[], opts: ResolveOptions): ResolvedCoverage {
  const out: ResolvedCoverage = { present: 0, embedded: 0, viaTwin: 0, missing: 0, unmapped: 0, outsideRoot: 0 };
  for (const p of paths) {
    const r = resolveModel(p, opts);
    if (r.embedded) out.embedded += 1;
    else if (r.file) { out.present += 1; if (r.viaTwin) out.viaTwin += 1; }
    else if (r.reason === "unmapped") out.unmapped += 1;
    else if (r.reason === "outside-root") out.outsideRoot += 1;
    else out.missing += 1;
  }
  return out;
}
