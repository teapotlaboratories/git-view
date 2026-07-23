package com.gitview.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for [buildDiffTree] / [flattenDiffTree] — the GitHub-style changed-files tree that backs the
 * diff view's file navigator. Locks in single-child-dir collapsing, dirs-before-files ordering, the
 * file-index mapping (used to jump the diff), and per-dir collapse.
 */
class DiffTreeTest {

    private fun f(path: String, adds: Int = 1, removes: Int = 0) =
        DiffFile(path, emptyList(), emptyList(), adds, removes)

    @Test fun collapsesSingleChildDirChains() {
        val files = listOf(
            f("android/app/ui/Components.kt", 68, 7),
            f("android/app/ui/DiffModel.kt", 55, 2),
            f("bridge/src/config.ts", 5, 2),
            f("README.md", 1, 0),
        )
        val rows = flattenDiffTree(buildDiffTree(files), emptySet())
        assertEquals(
            listOf("android/app/ui", "Components.kt", "DiffModel.kt", "bridge/src", "config.ts", "README.md"),
            rows.map { it.label },
        )
        assertEquals(listOf(0, 1, 1, 0, 1, 0), rows.map { it.depth })
        assertEquals(listOf(true, false, false, true, false, false), rows.map { it.isDir })
        // File leaves keep their original index into the DiffFile list (so a tap jumps to the right hunk).
        assertEquals(listOf(0, 1, 2, 3), rows.filter { !it.isDir }.map { it.fileIndex })
    }

    @Test fun collapsingADirHidesItsChildren() {
        val tree = buildDiffTree(listOf(f("a/b/one.kt"), f("a/b/two.kt"), f("c/three.kt")))
        assertEquals(
            listOf("a/b", "one.kt", "two.kt", "c", "three.kt"),
            flattenDiffTree(tree, emptySet()).map { it.label },
        )
        // Collapsing the "a/b" dir hides its two files but keeps sibling "c".
        assertEquals(
            listOf("a/b", "c", "three.kt"),
            flattenDiffTree(tree, setOf("a/b")).map { it.label },
        )
    }

    @Test fun dirsComeBeforeFilesAlphabetically() {
        val rows = flattenDiffTree(buildDiffTree(listOf(f("zeta.txt"), f("alpha/x.kt"), f("beta.txt"))), emptySet())
        assertEquals(listOf("alpha", "x.kt", "beta.txt", "zeta.txt"), rows.map { it.label })
    }

    @Test fun singleRootFileHasNoDir() {
        val rows = flattenDiffTree(buildDiffTree(listOf(f("README.md", 3, 1))), emptySet())
        assertEquals(1, rows.size)
        assertEquals("README.md", rows[0].label)
        assertEquals(false, rows[0].isDir)
        assertEquals(0, rows[0].fileIndex)
        assertEquals(3, rows[0].adds)
        assertEquals(1, rows[0].removes)
    }

    @Test fun emptyFilesYieldEmptyTree() {
        assertEquals(emptyList<DiffTreeRow>(), flattenDiffTree(buildDiffTree(emptyList()), emptySet()))
    }

    @Test fun sameDisplayPathStillYieldsUniqueRowKeys() {
        // Two sections can resolve to the same path (file→symlink change; "(file)" fallbacks). Row keys
        // must stay unique or the tree's LazyColumn crashes with "Key was already used".
        val rows = flattenDiffTree(buildDiffTree(listOf(f("x"), f("x"), f("(file)"), f("(file)"))), emptySet())
        assertEquals(rows.size, rows.map { it.key }.toSet().size) // all keys unique
        assertEquals(setOf(0, 1, 2, 3), rows.filter { !it.isDir }.map { it.fileIndex }.toSet()) // every file present
    }
}
