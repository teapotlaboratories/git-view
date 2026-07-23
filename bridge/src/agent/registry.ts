import type { AgentProvider } from "./types.js";
import type { AgentInfo } from "../wire.js";

/**
 * The set of chat providers this bridge offers, plus resolution by id. The app picks one at runtime (its
 * id rides on the WS `prompt` frame + the session REST routes); an unknown/absent id falls back to the
 * default. Registering a new provider here is the ONLY bridge change needed to add another agent.
 */
export class AgentRegistry {
  private readonly byId = new Map<string, AgentProvider>();

  constructor(
    providers: AgentProvider[],
    private readonly defaultId: string,
  ) {
    for (const p of providers) this.byId.set(p.id, p);
    if (!this.byId.has(defaultId)) throw new Error(`AgentRegistry: default provider "${defaultId}" not registered`);
  }

  /** The agents the app can offer in its switcher (id + label + capabilities). */
  list(): AgentInfo[] {
    return [...this.byId.values()].map((p) => ({ id: p.id, label: p.label, capabilities: p.capabilities }));
  }

  /** Resolve a provider by id, falling back to the default when the id is unknown or absent. */
  get(id?: string | null): AgentProvider {
    return (id ? this.byId.get(id) : undefined) ?? this.byId.get(this.defaultId)!;
  }

  /** Every registered provider (for fan-out like a permission response that carries no session/provider id). */
  all(): AgentProvider[] {
    return [...this.byId.values()];
  }
}
