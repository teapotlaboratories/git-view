import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "../config.js";
import { isInside } from "../util/paths.js";
import type { PermissionProfile, SessionProvider } from "../wire.js";

/**
 * Persisted, opened workspaces. Mirrors AuthManager: a single 0600 JSON file under `.gitview/`
 * (`workspaces.json`), loaded on boot and rewritten on every add. config.yaml is NEVER touched —
 * opening a folder as a workspace records it here, keyed by a stable, filename-safe id.
 */
export interface WorkspaceRecord {
  id: string;
  path: string; // absolute
  provider: SessionProvider;
  profile: PermissionProfile;
  openedAt: string; // ISO-8601, stamped by the caller
}

export class WorkspaceStore {
  private workspaces = new Map<string, WorkspaceRecord>();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf-8")) as { workspaces?: WorkspaceRecord[] };
      for (const w of raw.workspaces ?? []) this.workspaces.set(w.id, w);
    } catch {
      /* first run: no workspaces file yet */
    }
  }

  list(): WorkspaceRecord[] {
    return [...this.workspaces.values()];
  }

  byId(id: string): WorkspaceRecord | undefined {
    return this.workspaces.get(id);
  }

  byPath(path: string): WorkspaceRecord | undefined {
    return this.list().find((w) => w.path === path);
  }

  /** Record (or overwrite) a workspace and persist. Last write wins on a repeated id. */
  async add(rec: WorkspaceRecord): Promise<void> {
    this.workspaces.set(rec.id, rec);
    await this.persist();
  }

  /** Un-register a workspace and persist. The folder/files on disk are NEVER touched. */
  async remove(id: string): Promise<void> {
    this.workspaces.delete(id);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ workspaces: [...this.workspaces.values()] }, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}

/**
 * Ids of persisted workspaces that are STILL inside a currently-configured root — i.e. still served.
 *
 * A workspace record survives in workspaces.json across restarts, but the invariant "served paths ⊆
 * declared roots" must hold at all times: if the operator later empties or narrows `workspaceRoots`, a
 * previously-opened folder that now falls outside every root (or the whole feature being disabled) must
 * stop being served/watched. Roots are realpath'd (matching how confine() resolved them at open time),
 * so a symlinked root path still matches. Returns an empty set when the feature is off.
 */
export async function servedWorkspaceIds(cfg: Config, store: WorkspaceStore): Promise<Set<string>> {
  const served = new Set<string>();
  if (!cfg.workspacesEnabled) return served;
  const realRoots = await Promise.all(
    cfg.rootsList().map((r) => realpath(r.path).catch(() => r.path)),
  );
  for (const w of store.list()) {
    if (realRoots.some((rr) => isInside(rr, w.path))) served.add(w.id);
  }
  return served;
}
