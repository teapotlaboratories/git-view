package com.gitview.app.ui

/** A unified-diff line's role. Visual treatment is decided from this in `diffLineStyle`. */
internal enum class DiffLineKind { HEADER, HUNK, ADD, REMOVE, CONTEXT, META }

/**
 * Classifies each diff line with a tiny state machine that tracks whether we're inside a hunk body
 * (`inHunk`). This is what lets a removed line rendered as `---foo` (a struck-out SQL/YAML `-- foo`)
 * or an added `+++bar` read as REMOVE/ADD, while the real `--- a/x` / `+++ b/x` file headers — which
 * only ever appear before the first `@@` of a file — read as HEADER. A bare `@@` is always a hunk
 * header (content lines are prefixed with a space/`+`/`-`, so they can't start with `@@`).
 *
 * Assumes standard 2-way unified diffs — the only kind the bridge emits (it normalizes merge
 * commits to a first-parent 2-way diff, so git's combined `--cc` format with its 2-column line
 * prefixes never reaches here).
 *
 * Pure logic, deliberately free of Compose/Android types so it can be unit-tested on the JVM
 * (see `DiffClassifierTest`).
 */
internal fun classifyDiff(lines: List<String>): List<DiffLineKind> {
    val out = ArrayList<DiffLineKind>(lines.size)
    var inHunk = false
    for (line in lines) {
        out += when {
            line.startsWith("diff --git ") || line.startsWith("diff --combined ") ||
                line.startsWith("diff --cc ") -> { inHunk = false; DiffLineKind.HEADER }
            line.startsWith("@@") -> { inHunk = true; DiffLineKind.HUNK }
            !inHunk -> DiffLineKind.HEADER
            line.startsWith("+") -> DiffLineKind.ADD
            line.startsWith("-") -> DiffLineKind.REMOVE
            line.startsWith("\\") -> DiffLineKind.META // "\ No newline at end of file"
            else -> DiffLineKind.CONTEXT
        }
    }
    return out
}
