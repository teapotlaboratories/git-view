import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BlobEncoding, WriteResult } from "../wire.js";
import { tooLarge } from "../util/errors.js";
import { confine } from "../util/paths.js";
import type { AuditLog } from "../util/audit.js";

/**
 * Working-tree file mutations. These write to disk directly (git picks the changes up via
 * status/stage). Every path is confined (realpath symlink check) and every write is size-capped and
 * audited. Historical-ref reads never reach here — they go through gitService against an object id.
 */
export class FileService {
  constructor(
    private readonly writeSizeCapBytes: number,
    private readonly audit: AuditLog,
  ) {}

  private decode(content: string, encoding: BlobEncoding): Buffer {
    const buf = Buffer.from(content, encoding === "base64" ? "base64" : "utf-8");
    if (buf.length > this.writeSizeCapBytes) {
      throw tooLarge(`file is ${buf.length} bytes; cap is ${this.writeSizeCapBytes}`);
    }
    return buf;
  }

  async save(repoId: string, root: string, path: string, content: string, encoding: BlobEncoding,
    actor: "app" | "claude"): Promise<WriteResult> {
    const abs = await confine(root, path); // must exist
    const buf = this.decode(content, encoding);
    await writeFile(abs, buf);
    await this.audit.record({ actor, repo: repoId, action: "file.save", target: path, ok: true });
    return { ok: true };
  }

  async create(repoId: string, root: string, path: string, content: string, encoding: BlobEncoding,
    actor: "app" | "claude"): Promise<WriteResult> {
    const abs = await confine(root, path, /* mustExist */ false);
    const buf = this.decode(content, encoding);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf, { flag: "wx" }); // wx: fail if exists
    await this.audit.record({ actor, repo: repoId, action: "file.create", target: path, ok: true });
    return { ok: true };
  }

  async remove(repoId: string, root: string, path: string, actor: "app" | "claude"): Promise<WriteResult> {
    const abs = await confine(root, path);
    await rm(abs, { recursive: false, force: false });
    await this.audit.record({ actor, repo: repoId, action: "file.delete", target: path, ok: true });
    return { ok: true };
  }

  async renamePath(repoId: string, root: string, from: string, to: string,
    actor: "app" | "claude"): Promise<WriteResult> {
    const absFrom = await confine(root, from);
    const absTo = await confine(root, to, /* mustExist */ false);
    await mkdir(dirname(absTo), { recursive: true });
    await rename(absFrom, absTo);
    await this.audit.record({ actor, repo: repoId, action: "file.rename", target: `${from} -> ${to}`, ok: true });
    return { ok: true };
  }
}
