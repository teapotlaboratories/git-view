import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Runtime overrides for the host Claude agent: the SDK model and an in-app-settable credential.
 *
 * Mirrors AuthManager / WorkspaceStore: a single 0600 JSON file under `.gitview/`
 * (`claude-settings.json`), loaded on boot and rewritten on every mutation. config.yaml is NEVER
 * touched — the config `claude.model` remains the reset target when no override is stored.
 *
 * The stored secret NEVER leaves this process except as the injected credential env for the SDK
 * child; over the wire only a masked `hint` (last 4 chars) is ever exposed. See docs/SECURITY.md.
 */
export type ClaudeAuthMode = "host" | "api-key" | "subscription";

interface StoredAuth {
  mode: "api-key" | "subscription";
  secret: string;
}

interface StoredSettings {
  model?: string;
  auth?: StoredAuth;
}

export class ClaudeSettingsStore {
  private data: StoredSettings = {};

  constructor(
    private readonly file: string,
    private readonly defaultModel: string,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf-8")) as StoredSettings;
      const next: StoredSettings = {};
      if (typeof raw.model === "string" && raw.model) next.model = raw.model;
      if (
        raw.auth &&
        (raw.auth.mode === "api-key" || raw.auth.mode === "subscription") &&
        typeof raw.auth.secret === "string" &&
        raw.auth.secret
      ) {
        next.auth = { mode: raw.auth.mode, secret: raw.auth.secret };
      }
      this.data = next;
    } catch {
      /* first run or corrupt file: fall back to an empty (host) config */
      this.data = {};
    }
  }

  /** Effective model for the SDK query: the runtime override, else config.yaml's `claude.model`. */
  get model(): string {
    return this.data.model || this.defaultModel;
  }

  /** Effective credential mode. "host" means no override → child inherits ~/.claude. */
  get authMode(): ClaudeAuthMode {
    return this.data.auth?.mode ?? "host";
  }

  /** Masked secret tail (e.g. "…a1b2") for a UI reassurance, or null when auth=host. */
  get hint(): string | null {
    return this.data.auth ? "…" + this.data.auth.secret.slice(-4) : null;
  }

  /**
   * The env to inject into the SDK query `options.env`, or null when there is no credential override
   * (host mode → do NOT pass options.env at all, so the child inherits process.env / host ~/.claude).
   *
   * A copy of process.env (string values only) with BOTH ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN
   * removed, then exactly the one matching the stored mode set to the secret. PATH etc. survive.
   */
  credentialEnv(): Record<string, string> | null {
    const auth = this.data.auth;
    if (!auth) return null;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    delete env["ANTHROPIC_API_KEY"];
    delete env["ANTHROPIC_AUTH_TOKEN"];
    if (auth.mode === "api-key") env["ANTHROPIC_API_KEY"] = auth.secret;
    else env["ANTHROPIC_AUTH_TOKEN"] = auth.secret;
    return env;
  }

  /** Set (non-empty) or clear (empty/null → revert to config default) the model override; persist. */
  async setModel(model: string | null): Promise<void> {
    if (model && model.trim()) this.data.model = model;
    else delete this.data.model;
    await this.persist();
  }

  /** Store a credential override (secret must be non-empty) and persist 0600. */
  async setAuth(mode: "api-key" | "subscription", secret: string): Promise<void> {
    this.data.auth = { mode, secret };
    await this.persist();
  }

  /** Drop the credential override (revert to host ~/.claude) and persist. */
  async clearAuth(): Promise<void> {
    delete this.data.auth;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}
