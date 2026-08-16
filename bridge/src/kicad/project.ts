/**
 * What a KiCad *project* contains, so the app opens a design rather than a file (ADR-040).
 *
 * The viewer used to be file-shaped: `.kicad_sch` and `.kicad_pcb` each opened their own tab and nothing
 * tied them together. A person opens a *project*. This answers, for one path at one ref, which halves of
 * that project actually exist — and it is the **bridge** that answers, for the same reason `counterpart`
 * is a bridge answer: only it can see what is there at a given ref, and an app that guesses offers a tab
 * that 404s.
 *
 * Tabs must be what the project has, not a fixed `schematic | pcb | 3D` triple. Measured over the KiCad
 * 10 demos: of **36** projects, **17** have both halves, **18** are schematic-only and **1** is
 * board-only. A fixed triple shows a dead tab on more than half of them.
 *
 * **Everything here is naming, and naming alone.** No file is parsed — resolution is basename pairing
 * plus an existence check, so opening a project stays cheap even when the board behind it is 66 MB. The
 * board index and the schematic scene are still fetched per tab, on demand, exactly as before.
 */

/** The three files a project is addressed by. Order matters only for [projectBasename]. */
const EXTS = [".kicad_pro", ".kicad_sch", ".kicad_pcb"] as const;

export interface ProjectParts {
  /** Directory + basename with no extension — what the three files share. */
  base: string;
  /** Just the basename, for display. */
  name: string;
}

/**
 * Split a KiCad path into the stem its siblings share.
 *
 * Returns undefined for anything that is not one of the three project extensions, so a `.kicad_sym` or a
 * README cannot be mistaken for half a project.
 */
export function projectBasename(path: string): ProjectParts | undefined {
  const ext = EXTS.find((e) => path.toLowerCase().endsWith(e));
  if (!ext) return undefined;
  const base = path.slice(0, -ext.length);
  if (!base) return undefined;
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  return { base, name: base.slice(slash + 1) };
}

/** The three candidate paths for a project stem. */
export const projectPaths = (base: string): Record<"project" | "schematic" | "board", string> => ({
  project: `${base}.kicad_pro`,
  schematic: `${base}.kicad_sch`,
  board: `${base}.kicad_pcb`,
});

/**
 * Why a `.kicad_sch` did not resolve to a project, when it did not.
 *
 * Stated rather than left as a silent null, because the app shows an "Open in KiCad viewer" affordance
 * off the back of this and the two cases deserve different treatment: `no-project-file` is a design that
 * simply has no `.kicad_pro` (still perfectly viewable), while `ambiguous` means we found several and
 * refuse to guess.
 */
export type UnresolvedReason = "no-project-file" | "ambiguous" | "not-kicad";

/**
 * Which project a **sub-sheet** belongs to, given the `.kicad_pro` files beside it.
 *
 * This exists because basename pairing does not reach a sub-sheet: `video/` holds `video.kicad_pro` and
 * a root `video.kicad_sch`, but its seven sub-sheets are `muxdata.kicad_sch`, `pal-ntsc.kicad_sch` and
 * friends — names that pair with nothing.
 *
 * The obvious rule, "take the `.kicad_pro` in this directory", is **wrong in the corpus**: `ecc83/`
 * contains two (`ecc83-pp` and `ecc83-pp_v2`). So one candidate resolves, and anything else refuses.
 * Refusing is deliberate — opening the wrong project's viewer is worse than offering nothing, and the
 * only way to be certain is to walk the sheet hierarchy, which costs a parse this cheap route exists to
 * avoid. When that becomes worth it, it belongs here, behind the same return type.
 */
export function projectForSheet(
  siblingProjects: readonly string[],
): { project: string } | { reason: UnresolvedReason } {
  if (siblingProjects.length === 1) return { project: siblingProjects[0]! };
  return { reason: siblingProjects.length === 0 ? "no-project-file" : "ambiguous" };
}

/** What the route answers with. Absent fields mean "this project does not have that half". */
export interface ProjectView {
  name: string;
  project?: string;
  schematic?: string;
  board?: string;
  unresolved?: UnresolvedReason;
}

/** Which of the three files exist, as resolved paths. */
export interface PresentFiles {
  project?: string;
  schematic?: string;
  board?: string;
}

/**
 * Assemble the answer, or say the named file is not there.
 *
 * Pure and separate from the route because the "is not there" half is a rule, not plumbing, and it
 * shipped wrong: without it a typo'd path returned `200` with every field null, and a *made-up* sheet in
 * `ecc83/` came back `unresolved: "ambiguous"` — volunteering a fact about a directory in answer to a
 * question about a file that is not in it. The client has to have named something real, because every
 * other field here is a statement about that file's siblings.
 *
 * `siblingProjects` is only consulted when basename pairing found no `.kicad_pro`, so the common case
 * never pays for a directory listing; the caller is expected to skip the listing entirely in that case.
 */
export function describeProject(
  path: string,
  parts: ProjectParts,
  present: PresentFiles,
  siblingProjects: readonly string[] = [],
): ProjectView | { missing: true } {
  if (![present.project, present.schematic, present.board].includes(path)) return { missing: true };

  let projectPath = present.project;
  let unresolved: UnresolvedReason | undefined;
  if (!projectPath) {
    const found = projectForSheet(siblingProjects);
    if ("project" in found) projectPath = found.project;
    else unresolved = found.reason;
  }
  return {
    name: parts.name,
    ...(projectPath ? { project: projectPath } : {}),
    ...(present.schematic ? { schematic: present.schematic } : {}),
    ...(present.board ? { board: present.board } : {}),
    ...(unresolved ? { unresolved } : {}),
  };
}
