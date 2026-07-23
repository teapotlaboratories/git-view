import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { RepoConfig } from "../config.js";
import { confine } from "../util/paths.js";

export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size?: number;
  source: "written" | "attached" | "image";
}

type Entry =
  | { kind: "file"; repoPath: string; rel: string; name: string; mime: string; source: AttachmentMeta["source"] }
  | { kind: "bytes"; bytes: Buffer; name: string; mime: string; source: AttachmentMeta["source"] };

const MAX = 300; // cap the store by entry count; oldest evicted
const MAX_BYTES = 64 * 1024 * 1024; // AND by resident image bytes — 300 multi-MB images must not pin ~GB

/**
 * Registry of files the agent handed to the chat, served at GET /v1/attachments/:id. A "file" entry is a
 * repo-relative path re-read (path-confined) at request time; a "bytes" entry (a tool-result image) is held
 * in memory. Populated by any AgentProvider; the neutral `attachment` ServerEvent + this store keep the
 * feature agent-agnostic.
 */
export class AttachmentStore {
  private byId = new Map<string, Entry>();
  private order: string[] = [];
  private seq = 0;
  private bytesHeld = 0; // running total of in-memory "bytes" entries, for MAX_BYTES eviction

  /** Register a repo file. Returns null if the path escapes the repo (can't be served safely). */
  addFile(repo: RepoConfig, path: string, source: AttachmentMeta["source"] = "written"): AttachmentMeta | null {
    const rel = toRepoRel(repo.path, path);
    if (rel == null) return null;
    const name = rel.split("/").pop() || rel;
    return this.register({ kind: "file", repoPath: repo.path, rel, name, mime: mimeOf(name), source });
  }

  /** Register in-memory bytes (e.g. an image from a tool result). */
  addBytes(bytes: Buffer, name: string, mime: string, source: AttachmentMeta["source"] = "image"): AttachmentMeta {
    return this.register({ kind: "bytes", bytes, name, mime, source });
  }

  private register(entry: Entry): AttachmentMeta {
    const id = `att_${++this.seq}`;
    this.byId.set(id, entry);
    this.order.push(id);
    if (entry.kind === "bytes") this.bytesHeld += entry.bytes.length;
    // Evict oldest by count OR by resident bytes, but never below the single newest entry.
    while (this.order.length > 1 && (this.order.length > MAX || this.bytesHeld > MAX_BYTES)) {
      const old = this.order.shift();
      if (!old) break;
      const e = this.byId.get(old);
      if (e?.kind === "bytes") this.bytesHeld -= e.bytes.length;
      this.byId.delete(old);
    }
    return {
      id,
      name: entry.name,
      mime: entry.mime,
      size: entry.kind === "bytes" ? entry.bytes.length : undefined,
      source: entry.source,
    };
  }

  /** Serve an attachment's bytes; a file entry is read (path-confined) fresh. Null if unknown/gone. */
  async read(id: string): Promise<{ bytes: Buffer; mime: string; name: string } | null> {
    const e = this.byId.get(id);
    if (!e) return null;
    if (e.kind === "bytes") return { bytes: e.bytes, mime: e.mime, name: e.name };
    const abs = await confine(e.repoPath, e.rel).catch(() => null);
    if (!abs) return null;
    const bytes = await readFile(abs).catch(() => null);
    return bytes ? { bytes, mime: e.mime, name: e.name } : null;
  }
}

/** Coerce a Write's `file_path` (often absolute) or an attach path to a repo-relative one; null if outside. */
function toRepoRel(repoPath: string, p: string): string | null {
  const rel = isAbsolute(p) ? relative(repoPath, p) : p;
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

function mimeOf(name: string): string {
  switch (name.substring(name.lastIndexOf(".") + 1).toLowerCase()) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "pdf": return "application/pdf";
    case "apk": return "application/vnd.android.package-archive";
    case "json": return "application/json";
    case "zip": return "application/zip";
    case "txt":
    case "md":
    case "log":
    case "csv": return "text/plain";
    default: return "application/octet-stream";
  }
}
