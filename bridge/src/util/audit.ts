import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only audit log. Every WRITE (REST or via the MCP tool surface) and every Claude TOOL CALL
 * is recorded here as one JSON line. See docs/SECURITY.md — this is the accountability backstop for
 * a low-friction read/write bridge.
 */
export interface AuditEntry {
  ts: string; // ISO-8601
  actor: "app" | "claude";
  repo: string;
  action: string; // e.g. "file.save", "commit", "tool:mcp__gitview__saveFile", "tool:Bash"
  target?: string; // path / ref / tool input summary
  ok: boolean;
  detail?: string;
}

export class AuditLog {
  constructor(private readonly file: string) {}

  async record(entry: Omit<AuditEntry, "ts">): Promise<void> {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, line, "utf-8");
    } catch (err) {
      // Never let audit failure break the request, but make it loud.
      console.error("[audit] failed to write entry:", (err as Error).message, "->", line.trim());
    }
  }
}
