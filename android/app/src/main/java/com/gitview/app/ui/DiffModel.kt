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
            isFileHeader(line) -> { inHunk = false; DiffLineKind.HEADER }
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

/** True for the line that begins a file's section in a unified diff (the split boundary). */
internal fun isFileHeader(line: String): Boolean =
    line.startsWith("diff --git ") || line.startsWith("diff --combined ") || line.startsWith("diff --cc ")

/** One file's slice of a unified diff: display path, its raw lines + per-line kinds, and ± line counts. */
internal data class DiffFile(
    val path: String,
    val lines: List<String>,
    val kinds: List<DiffLineKind>,
    val adds: Int,
    val removes: Int,
)

/** Best-effort display path for a file section: prefer the `+++ b/…` (new) path, fall back to
 *  `--- a/…` (a deleted file), then the `diff --git` boundary line, then a generic label. */
private fun displayPath(sectionLines: List<String>): String {
    fun clean(p: String) = p.substringBefore('\t').trim().removePrefix("a/").removePrefix("b/")
    sectionLines.firstOrNull { it.startsWith("+++ ") }?.removePrefix("+++ ")?.trim()
        ?.let { if (it != "/dev/null") return clean(it) }
    sectionLines.firstOrNull { it.startsWith("--- ") }?.removePrefix("--- ")?.trim()
        ?.let { if (it != "/dev/null") return clean(it) }
    sectionLines.firstOrNull(::isFileHeader)?.let { header ->
        val rest = header.substringAfter(" --git ", "")
            .ifEmpty { header.substringAfter("--cc ").substringAfter("--combined ") }
        val bIdx = rest.indexOf(" b/")
        if (bIdx >= 0) return rest.substring(bIdx + 3).trim()
        if (rest.isNotBlank()) return clean(rest)
    }
    return "(file)"
}

/**
 * Split a classified unified diff into per-file sections at each `diff --git` boundary. Any lines
 * before the first boundary (unusual — a well-formed git diff starts with one) become a leading
 * section; a diff with no boundary at all comes back as a single section. Pure logic (JVM-testable).
 */
internal fun splitDiffIntoFiles(lines: List<String>, kinds: List<DiffLineKind>): List<DiffFile> {
    val files = ArrayList<DiffFile>()
    var start = 0
    fun flush(end: Int) {
        if (end <= start) return
        val secLines = lines.subList(start, end).toList()
        val secKinds = kinds.subList(start, end).toList()
        files += DiffFile(
            displayPath(secLines), secLines, secKinds,
            adds = secKinds.count { it == DiffLineKind.ADD },
            removes = secKinds.count { it == DiffLineKind.REMOVE },
        )
    }
    for (i in lines.indices) if (isFileHeader(lines[i]) && i > start) { flush(i); start = i }
    flush(lines.size)
    return files
}

// ---- changed-files tree (GitHub-style) --------------------------------------

/** A node in the changed-files tree: either a directory (with children) or a file leaf. */
internal sealed class DiffNode {
    abstract val name: String
    abstract val path: String // full path key, unique within the tree
    data class Dir(override val name: String, override val path: String, val children: List<DiffNode>) : DiffNode()
    data class FileLeaf(
        override val name: String, override val path: String,
        val fileIndex: Int, val adds: Int, val removes: Int,
    ) : DiffNode()
}

/** A flattened, indented tree row for rendering (files carry their [fileIndex] into the [DiffFile] list). */
internal data class DiffTreeRow(
    val depth: Int,
    val label: String,
    val isDir: Boolean,
    val expanded: Boolean, // dir open/closed; always false for files
    val fileIndex: Int,    // -1 for dirs
    val adds: Int,
    val removes: Int,
    val key: String,
)

private data class DiffItem(val segments: List<String>, val fileIndex: Int, val file: DiffFile)

/**
 * Build a directory tree from the changed files, GitHub-style: directories first (alphabetical), then
 * files; a chain of single-child directories collapses into one row (`a/b/c`). Each leaf keeps the
 * index of its [DiffFile] so a tap can jump the diff to it. Pure logic (JVM-testable).
 */
internal fun buildDiffTree(files: List<DiffFile>): List<DiffNode> =
    buildLevel(files.mapIndexed { i, f -> DiffItem(f.path.split("/").filter { it.isNotEmpty() }, i, f) }, "")
        .map { collapse(it) }

private fun buildLevel(items: List<DiffItem>, prefix: String): List<DiffNode> {
    val fileNodes = items.filter { it.segments.size <= 1 }.map {
        val name = it.segments.lastOrNull() ?: it.file.path
        DiffNode.FileLeaf(name, prefix + name, it.fileIndex, it.file.adds, it.file.removes)
    }.sortedBy { it.name.lowercase() }
    val dirNodes = items.filter { it.segments.size > 1 }
        .groupBy { it.segments.first() }
        .map { (name, group) ->
            val childPrefix = "$prefix$name/"
            DiffNode.Dir(name, childPrefix.trimEnd('/'), buildLevel(group.map { it.copy(segments = it.segments.drop(1)) }, childPrefix))
        }.sortedBy { it.name.lowercase() }
    return dirNodes + fileNodes // dirs first
}

/** Collapse a dir whose only child is another dir into a single `parent/child` row (recursively). */
private fun collapse(node: DiffNode): DiffNode = when (node) {
    is DiffNode.FileLeaf -> node
    is DiffNode.Dir -> {
        val children = node.children.map { collapse(it) }
        val only = children.singleOrNull()
        if (only is DiffNode.Dir) DiffNode.Dir("${node.name}/${only.name}", only.path, only.children)
        else DiffNode.Dir(node.name, node.path, children)
    }
}

/** Flatten the tree to indented rows. A dir is open unless its path is in [collapsed] (default: all open). */
internal fun flattenDiffTree(nodes: List<DiffNode>, collapsed: Set<String>, depth: Int = 0): List<DiffTreeRow> {
    val out = ArrayList<DiffTreeRow>()
    for (n in nodes) when (n) {
        is DiffNode.Dir -> {
            val open = n.path !in collapsed
            out += DiffTreeRow(depth, n.name, isDir = true, expanded = open, fileIndex = -1, adds = 0, removes = 0, key = "d:${n.path}")
            if (open) out += flattenDiffTree(n.children, collapsed, depth + 1)
        }
        is DiffNode.FileLeaf ->
            // Key by the unique fileIndex, not the path: two sections can resolve to the same display
            // path (a file→symlink change emits two `diff --git a/x b/x`; unparseable sections fall back
            // to "(file)"), and a duplicate key would crash the tree's LazyColumn.
            out += DiffTreeRow(depth, n.name, isDir = false, expanded = false, fileIndex = n.fileIndex, adds = n.adds, removes = n.removes, key = "f:${n.fileIndex}")
    }
    return out
}
