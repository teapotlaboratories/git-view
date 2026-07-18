import { spawn, type ChildProcess } from "node:child_process";
import type { RepoConfig } from "../config.js";
import type { StartSessionResponse } from "../wire.js";

/**
 * Manages the PRIMARY session provider: Anthropic Remote Control (research preview, shipped Feb 2026;
 * verified). It launches a `claude remote-control` session ON THIS MACHINE and surfaces the connect
 * URL/QR to the app, which opens it in the Claude mobile app / claude.ai/code.
 *
 * Verified constraints baked in here (see docs/DECISIONS.md ADR-010, docs/SECURITY.md):
 *  - OUTBOUND-HTTPS ONLY: the session registers with the Anthropic API and polls; no inbound ports.
 *  - SUBSCRIPTION AUTH: requires a claude.ai Pro/Max/Team/Enterprise plan; API keys are rejected, so
 *    we UNSET ANTHROPIC_API_KEY in the child env.
 *  - Transcript is stored on Anthropic servers while connected (trust delta vs. the local-sdk path).
 *  - Prefer isolation flags: `--sandbox` (off by default) and `--spawn worktree` (per-session git
 *    worktree; requires a git repo).
 *  - Research-preview: one connection per session; times out after a network outage.
 *
 * NOTE: exact flag names are pinned to the CLI version documented in SETUP.md — re-verify on upgrade.
 */
export class RemoteControlManager {
  private sessions = new Map<string, ChildProcess>();

  constructor(private readonly useSandbox: boolean) {}

  async start(repo: RepoConfig, sandbox: boolean = this.useSandbox): Promise<StartSessionResponse> {
    const args = ["remote-control"];
    if (sandbox) args.push("--sandbox");
    args.push("--spawn", "worktree"); // each on-demand session gets its own git worktree

    const env = { ...process.env };
    delete env["ANTHROPIC_API_KEY"]; // Remote Control rejects API keys — must use subscription OAuth
    delete env["ANTHROPIC_AUTH_TOKEN"];

    const child = spawn("claude", args, { cwd: repo.path, env, stdio: ["ignore", "pipe", "pipe"] });

    const url = await this.readConnectUrl(child).catch((e) => {
      child.kill();
      throw e;
    });

    const sessionId = `rc_${repo.id}_${child.pid ?? "0"}`;
    this.sessions.set(sessionId, child);
    child.on("exit", () => this.sessions.delete(sessionId));

    return { sessionId, provider: "remote-control", connect: { url } };
  }

  stop(sessionId: string): void {
    this.sessions.get(sessionId)?.kill();
    this.sessions.delete(sessionId);
  }

  stopAll(): void {
    for (const child of this.sessions.values()) child.kill();
    this.sessions.clear();
  }

  /** Scrape the session URL the CLI prints on startup. */
  private readConnectUrl(child: ChildProcess): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for remote-control URL")), 30_000);
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf-8");
        const m = buf.match(/https:\/\/claude\.ai\/code\/\S+/);
        if (m) {
          clearTimeout(timer);
          child.stdout?.off("data", onData);
          resolve(m[0]);
        }
      };
      child.stdout?.on("data", onData);
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`claude remote-control exited early (code ${code})`));
      });
    });
  }
}
