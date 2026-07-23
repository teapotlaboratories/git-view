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

    @Test fun classifiesAttachmentViewKind() {
        // mime wins for image / pdf / text
        assertEquals(AttachmentViewKind.IMAGE, attachmentViewKind("photo.png", "image/png"))
        assertEquals(AttachmentViewKind.PDF, attachmentViewKind("report.pdf", "application/pdf"))
        assertEquals(AttachmentViewKind.MARKDOWN, attachmentViewKind("README.md", "text/markdown"))
        assertEquals(AttachmentViewKind.TEXT, attachmentViewKind("notes.txt", "text/plain"))
        // extension is the fallback when the bridge sends octet-stream
        assertEquals(AttachmentViewKind.TEXT, attachmentViewKind("Main.kt", "application/octet-stream"))
        assertEquals(AttachmentViewKind.PDF, attachmentViewKind("doc.PDF", "application/octet-stream"))
        assertEquals(AttachmentViewKind.MARKDOWN, attachmentViewKind("guide.markdown", "application/octet-stream"))
        // unknown/binary → download-only
        assertEquals(AttachmentViewKind.NONE, attachmentViewKind("app.apk", "application/vnd.android.package-archive"))
        assertEquals(AttachmentViewKind.NONE, attachmentViewKind("archive.zip", "application/zip"))
        assertEquals(AttachmentViewKind.NONE, attachmentViewKind("noext", "application/octet-stream"))
        // SVG is XML text, not a raster image → text viewer (BitmapFactory can't decode it)
        assertEquals(AttachmentViewKind.TEXT, attachmentViewKind("logo.svg", "image/svg+xml"))
        assertEquals(AttachmentViewKind.TEXT, attachmentViewKind("logo.svg", "application/octet-stream"))
        // dotless well-known text filenames
        assertEquals(AttachmentViewKind.TEXT, attachmentViewKind("Dockerfile", "application/octet-stream"))
        assertEquals(AttachmentViewKind.TEXT, attachmentViewKind("Makefile", "application/octet-stream"))
    }

    @Test fun svgIsNotTreatedAsInlineImage() {
        // isImage gates the inline thumbnail; SVG must not hit BitmapFactory (would spin forever).
        assertFalse(AttachmentItem("s", "logo.svg", "image/svg+xml", 100).isImage)
        assertTrue(AttachmentItem("p", "logo.png", "image/png", 100).isImage)
    }

    @Test fun attachmentIsViewableFlag() {
        assertTrue(AttachmentItem("a", "Main.kt", "application/octet-stream", null).isViewable)
        assertTrue(AttachmentItem("b", "logo.png", "image/png", 10).isViewable)
        assertFalse(AttachmentItem("c", "app.apk", "application/vnd.android.package-archive", 999).isViewable)
    }
}
