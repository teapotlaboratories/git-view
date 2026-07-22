import type { Config, RepoConfig } from "./config.js";
import type { WorkspaceStore } from "./workspaces/store.js";
import type { PermissionProfile, SessionProvider } from "./wire.js";

/** A persisted workspace record → the RepoConfig shape the rest of the bridge resolves against. */
export function asRepoConfig(w: {
  id: string;
  path: string;
  provider: SessionProvider;
  profile: PermissionProfile;
}): RepoConfig {
  return { id: w.id, name: w.id, path: w.path, provider: w.provider, profile: w.profile };
}

/**
 * The single source of truth for "which repos exist" = config repos + persisted workspaces that are still
 * served (feature enabled AND inside a current root; see servedWorkspaceIds). EVERY subsystem that resolves
 * a repo by id — the REST routes AND the live/chat channel — must go through this, so an opened workspace
 * gets the full surface (files, git, AND chat), not just the REST half. Config wins on an id collision.
 */
export class RepoRegistry {
  constructor(
    private readonly cfg: Config,
    private readonly workspaces: WorkspaceStore,
    private readonly served: Set<string>,
  ) {}

  list(): RepoConfig[] {
    const byId = new Map<string, RepoConfig>();
    if (this.cfg.workspacesEnabled) {
      for (const w of this.workspaces.list()) if (this.served.has(w.id)) byId.set(w.id, asRepoConfig(w));
    }
    for (const r of this.cfg.repos) byId.set(r.id, r); // config wins
    return [...byId.values()];
  }

  byId(id: string): RepoConfig | undefined {
    const c = this.cfg.repoById(id);
    if (c) return c;
    if (!this.cfg.workspacesEnabled || !this.served.has(id)) return undefined;
    const w = this.workspaces.byId(id);
    return w ? asRepoConfig(w) : undefined;
  }

  /** Mark a just-opened workspace (already confined to a current root) as served. */
  markServed(id: string): void {
    this.served.add(id);
  }

  /** Stop serving a workspace (its record is being removed). Config repos are unaffected. */
  unserve(id: string): void {
    this.served.delete(id);
  }
}
