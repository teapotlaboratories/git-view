package com.gitview.app.ui.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure-logic tests for the chat tool-call parsing (no Compose/Android types). */
class ChatModelsTest {
    private fun obj(s: String) = Json.parseToJsonElement(s) as JsonObject

    @Test fun classifiesToolNames() {
        assertEquals(ToolKind.READ, toolKindOf("Read"))
        assertEquals(ToolKind.EDIT, toolKindOf("Edit"))
        assertEquals(ToolKind.MULTI_EDIT, toolKindOf("MultiEdit"))
        assertEquals(ToolKind.WRITE, toolKindOf("Write"))
        assertEquals(ToolKind.BASH, toolKindOf("Bash"))
        assertEquals(ToolKind.GREP, toolKindOf("Grep"))
        // MCP-prefixed names strip the mcp__server__ segment.
        assertEquals(ToolKind.EDIT, toolKindOf("mcp__gitview__edit_file"))
        assertEquals(ToolKind.WRITE, toolKindOf("mcp__gitview__create_file"))
        assertEquals(ToolKind.OTHER, toolKindOf("SomethingElse"))
    }

    @Test fun extractsPath() {
        assertEquals("src/a.ts", toolPath(obj("""{"file_path":"src/a.ts"}""")))
        assertEquals("pkg/", toolPath(obj("""{"path":"pkg/"}""")))
        assertEquals("*.kt", toolPath(obj("""{"pattern":"*.kt"}""")))
        assertNull(toolPath(null))
        assertNull(toolPath(obj("""{"limit":10}""")))
    }

    @Test fun synthesizesEditDiff() {
        val d = toolEditDiff(ToolKind.EDIT, "a.ts", obj("""{"old_string":"foo\nbar","new_string":"baz"}"""))!!
        assertTrue(d.startsWith("@@ a.ts @@"))
        assertTrue(d.contains("\n-foo"))
        assertTrue(d.contains("\n-bar"))
        assertTrue(d.contains("\n+baz"))
    }

    @Test fun writeDiffIsAllAdds() {
        val d = toolEditDiff(ToolKind.WRITE, "n.txt", obj("""{"content":"l1\nl2"}"""))!!
        assertTrue(d.contains("+l1"))
        assertTrue(d.contains("+l2"))
        assertFalse(d.contains("\n-"))
    }

    @Test fun multiEditConcatenatesHunks() {
        val d = toolEditDiff(
            ToolKind.MULTI_EDIT, "m.kt",
            obj("""{"edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":"d"}]}"""),
        )!!
        assertTrue(d.contains("-a"))
        assertTrue(d.contains("+b"))
        assertTrue(d.contains("-c"))
        assertTrue(d.contains("+d"))
    }

    @Test fun readHasNoEditDiff() {
        assertNull(toolEditDiff(ToolKind.READ, "a.ts", obj("""{"file_path":"a.ts"}""")))
    }

    @Test fun bashSubtitleIsCommand() {
        assertEquals("ls -la", toolSubtitle(ToolKind.BASH, obj("""{"command":"ls -la"}""")))
        assertNull(toolSubtitle(ToolKind.READ, obj("""{"file_path":"a.ts"}""")))
    }
}
