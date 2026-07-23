package com.gitview.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for [splitDiffIntoFiles] — the per-file grouping that backs the collapsible diff view.
 * Locks in the boundary detection (one section per `diff --git`), display-path resolution (new path,
 * or the old path for a deletion), and the ± line counts shown in each file header.
 */
class DiffSplitTest {

    private fun split(diff: String): List<DiffFile> {
        val lines = diff.split("\n")
        return splitDiffIntoFiles(lines, classifyDiff(lines))
    }

    @Test fun twoFilesSplitWithPathsAndCounts() {
        val diff = """
            diff --git a/one.kt b/one.kt
            --- a/one.kt
            +++ b/one.kt
            @@ -1,2 +1,2 @@
            -a
            +b
             kept
            diff --git a/dir/two.kt b/dir/two.kt
            --- a/dir/two.kt
            +++ b/dir/two.kt
            @@ -1 +1,2 @@
             x
            +y
        """.trimIndent()
        val files = split(diff)
        assertEquals(2, files.size)
        assertEquals("one.kt", files[0].path)
        assertEquals(1, files[0].adds)
        assertEquals(1, files[0].removes)
        assertEquals("dir/two.kt", files[1].path)
        assertEquals(1, files[1].adds)
        assertEquals(0, files[1].removes)
        // Every source line is preserved across the split (no drops, no overlap).
        assertEquals(diff.split("\n").size, files.sumOf { it.lines.size })
    }

    @Test fun addedFileUsesNewPath() {
        val diff = """
            diff --git a/new.kt b/new.kt
            new file mode 100644
            --- /dev/null
            +++ b/new.kt
            @@ -0,0 +1 @@
            +hello
        """.trimIndent()
        val files = split(diff)
        assertEquals(1, files.size)
        assertEquals("new.kt", files[0].path)
        assertEquals(1, files[0].adds)
    }

    @Test fun deletedFileFallsBackToOldPath() {
        val diff = """
            diff --git a/gone.kt b/gone.kt
            deleted file mode 100644
            --- a/gone.kt
            +++ /dev/null
            @@ -1 +0,0 @@
            -bye
        """.trimIndent()
        val files = split(diff)
        assertEquals(1, files.size)
        assertEquals("gone.kt", files[0].path)
        assertEquals(1, files[0].removes)
    }

    @Test fun singleFileNoBoundaryStillOneSection() {
        // A diff body with no `diff --git` boundary (e.g. a bare hunk) comes back as one section.
        val diff = """
            --- a/x
            +++ b/x
            @@ -1 +1 @@
            -a
            +b
        """.trimIndent()
        val files = split(diff)
        assertEquals(1, files.size)
        assertEquals("x", files[0].path)
    }

    @Test fun emptyInputYieldsNoFiles() {
        assertEquals(emptyList<DiffFile>(), splitDiffIntoFiles(emptyList(), emptyList()))
    }
}
