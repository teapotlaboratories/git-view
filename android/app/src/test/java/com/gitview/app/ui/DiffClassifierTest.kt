package com.gitview.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for [classifyDiff] — the hunk-aware unified-diff line classifier. These lock in the
 * behavior that a hand check missed and an adversarial review surfaced: content lines that *look*
 * like file headers (`--- foo`, `+++ bar`) must read as REMOVE/ADD when they occur inside a hunk.
 */
class DiffClassifierTest {

    private fun kinds(diff: String) = classifyDiff(diff.split("\n"))

    /** Role of the (unique) [line] within [diff]. */
    private fun kindOf(diff: String, line: String): DiffLineKind {
        val lines = diff.split("\n")
        val i = lines.indexOf(line)
        require(i >= 0) { "line not present verbatim: <$line>" }
        return kinds(diff)[i]
    }

    @Test fun standardDiffMapsEveryRole() {
        val diff = """
            diff --git a/App.kt b/App.kt
            index 111aaa..222bbb 100644
            --- a/App.kt
            +++ b/App.kt
            @@ -1,3 +1,3 @@
             fun main() {
            -    old()
            +    new()
             }
        """.trimIndent()
        assertEquals(DiffLineKind.HEADER, kindOf(diff, "diff --git a/App.kt b/App.kt"))
        assertEquals(DiffLineKind.HEADER, kindOf(diff, "index 111aaa..222bbb 100644"))
        assertEquals(DiffLineKind.HEADER, kindOf(diff, "--- a/App.kt"))
        assertEquals(DiffLineKind.HEADER, kindOf(diff, "+++ b/App.kt"))
        assertEquals(DiffLineKind.HUNK, kindOf(diff, "@@ -1,3 +1,3 @@"))
        assertEquals(DiffLineKind.CONTEXT, kindOf(diff, " fun main() {"))
        assertEquals(DiffLineKind.REMOVE, kindOf(diff, "-    old()"))
        assertEquals(DiffLineKind.ADD, kindOf(diff, "+    new()"))
    }

    @Test fun contentLinesThatLookLikeHeadersAreAddOrRemove() {
        // Body: a removed "-- sql comment" renders as "--- sql comment"; a removed "---" (yaml/md
        // separator) renders as "----"; an added "++count" renders as "+++count".
        val diff = """
            diff --git a/x b/x
            index 1..2 100644
            --- a/x
            +++ b/x
            @@ -1,3 +1,2 @@
            --- sql comment
            ----
            +++count
             kept
        """.trimIndent()
        assertEquals(DiffLineKind.HEADER, kindOf(diff, "--- a/x"))       // real file header (pre-hunk)
        assertEquals(DiffLineKind.HEADER, kindOf(diff, "+++ b/x"))
        assertEquals(DiffLineKind.REMOVE, kindOf(diff, "--- sql comment")) // in-hunk, NOT a header
        assertEquals(DiffLineKind.REMOVE, kindOf(diff, "----"))
        assertEquals(DiffLineKind.ADD, kindOf(diff, "+++count"))
        assertEquals(DiffLineKind.CONTEXT, kindOf(diff, " kept"))
    }

    @Test fun noNewlineMarkerIsMeta() {
        val diff = """
            diff --git a/x b/x
            index 1..2 100644
            --- a/x
            +++ b/x
            @@ -1 +1 @@
            -old
            \ No newline at end of file
            +new
            \ No newline at end of file
        """.trimIndent()
        val lines = diff.split("\n")
        val ks = classifyDiff(lines)
        lines.forEachIndexed { i, l ->
            if (l == "\\ No newline at end of file") assertEquals(DiffLineKind.META, ks[i])
        }
        assertEquals(DiffLineKind.REMOVE, kindOf(diff, "-old"))
        assertEquals(DiffLineKind.ADD, kindOf(diff, "+new"))
    }

    @Test fun secondFileHeaderResetsHunkState() {
        val diff = """
            diff --git a/one b/one
            --- a/one
            +++ b/one
            @@ -1 +1 @@
            -a
            +b
            diff --git a/two b/two
            --- a/two
            +++ b/two
            @@ -1 +1 @@
            -c
            +d
        """.trimIndent()
        // After the first hunk, the next file's headers must classify as HEADER, not REMOVE/ADD.
        assertEquals(DiffLineKind.HEADER, kindOf(diff, "diff --git a/two b/two"))
        assertEquals(DiffLineKind.HEADER, kindOf(diff, "--- a/two"))
        assertEquals(DiffLineKind.HEADER, kindOf(diff, "+++ b/two"))
        assertEquals(DiffLineKind.REMOVE, kindOf(diff, "-c"))
        assertEquals(DiffLineKind.ADD, kindOf(diff, "+d"))
    }

    @Test fun countsEveryHunkHeader() {
        val diff = """
            diff --git a/x b/x
            --- a/x
            +++ b/x
            @@ -1,2 +1,2 @@
            -a
            +b
            @@ -10,2 +10,2 @@
            -c
            +d
        """.trimIndent()
        assertEquals(2, kinds(diff).count { it == DiffLineKind.HUNK })
    }

    @Test fun combinedDiffHeaderAndHunkAreRecognized() {
        // The bridge normalizes merges to 2-way, so combined diffs shouldn't reach the classifier,
        // but its header and @@@ hunk line are still handled sanely rather than mis-flipping state.
        val diff = """
            diff --cc x
            index 1a,2b..3c
            @@@ -1,1 -1,1 +1,1 @@@
        """.trimIndent()
        assertEquals(DiffLineKind.HEADER, kindOf(diff, "diff --cc x"))
        assertEquals(DiffLineKind.HUNK, kindOf(diff, "@@@ -1,1 -1,1 +1,1 @@@"))
    }

    @Test fun emptyInputYieldsEmptyOutput() {
        assertEquals(emptyList<DiffLineKind>(), classifyDiff(emptyList()))
    }
}
