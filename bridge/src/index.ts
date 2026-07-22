import { loadConfig } from "./config.js";
import { AuthManager } from "./auth/pairing.js";
import { AuditLog } from "./util/audit.js";
import { FileService } from "./git/fileService.js";
import { GitWrite } from "./git/gitWrite.js";
import { SessionManager } from "./claude/sessionManager.js";
import { ClaudeSettingsStore } from "./claude/settingsStore.js";
import { ClaudeLoginManager } from "./claude/loginManager.js";
import { buildServer } from "./http/rest.js";
import { LiveChannel } from "./ws/liveChannel.js";
import { RepoWatcher } from "./git/repoWatcher.js";
import { WorkspaceStore, servedWorkspaceIds } from "./workspaces/store.js";
import { RepoRegistry } from "./repoRegistry.js";

async function main(): Promise<void> {
  const configPath = process.env["GITVIEW_CONFIG"] ?? process.argv[2] ?? "./config.yaml";
  const cfg = await loadConfig(configPath);

  const audit = new AuditLog(cfg.auditFile);
  const auth = new AuthManager(cfg.tokensFile, cfg.pairingCodeTtlMs);
  await auth.load();

  const files = new FileService(cfg.writeSizeCapBytes, audit);
  const gitWrite = new GitWrite(audit);
  const claudeSettings = new ClaudeSettingsStore(cfg.claudeSettingsFile, cfg.claude.model);
  await claudeSettings.load();
  const claudeLogin = new ClaudeLoginManager(claudeSettings);
  const sessions = new SessionManager(cfg.claude, files, gitWrite, claudeSettings);

  const workspaces = new WorkspaceStore(cfg.workspacesFile);
  await workspaces.load();
  // Only persisted workspaces still inside a current root are served/watched — narrowing or disabling
  // workspaceRoots revokes the rest. The open route adds to this same set at runtime.
  const served = await servedWorkspaceIds(cfg, workspaces);
  // One registry (config repos + served workspaces) shared by the REST routes AND the live/chat channel,
  // so an opened workspace can be chatted with, not just browsed.
  const registry = new RepoRegistry(cfg, workspaces, served);

  // Constructed before buildServer so the open-workspace route can attach a runtime watcher + broadcast.
  const live = new LiveChannel(auth, sessions, registry);
  const watcher = new RepoWatcher(cfg.repos, (repo, paths) => live.broadcastRepoChanged(repo, paths));

  const app = await buildServer({ cfg, auth, audit, files, gitWrite, sessions, claudeSettings, claudeLogin, workspaces, registry, watcher, live });
  await app.listen({ host: cfg.bind, port: cfg.port });

  live.attach(app.server);

  // Push working-tree/git-state changes to connected apps so the UI stays live.
  watcher.start();
  // Re-watch persisted workspaces across restarts — but only those still served (inside a current root)
  // and not already covered by a config repo.
  for (const id of served) {
    const w = workspaces.byId(id);
    if (!w || cfg.repoById(w.id)) continue;
    watcher.watch({ id: w.id, name: w.id, path: w.path, provider: w.provider, profile: w.profile });
  }

  const ttlMin = Math.round(cfg.pairingCodeTtlMs / 60_000);
  console.log(`\nGitView bridge listening on http://${cfg.bind}:${cfg.port}`);
  console.log(`Repos: ${cfg.repos.map((r) => r.id).join(", ")}`);
  console.log(`\n  Pairing code (valid ~${ttlMin} min):  ${auth.currentPairingCode}`);
  console.log(`  Print a fresh code without restarting:  kill -HUP ${process.pid}   (service: systemctl reload gitview-bridge)\n`);
  console.log("Front this with Tailscale Serve — never expose a read/write bridge publicly. See docs/SECURITY.md.");

  // Refresh the pairing code at runtime (no restart, issued tokens unaffected). Overrides Node's default
  // SIGHUP-terminates behavior. Interactive: `kill -HUP <pid>`. As the .deb service: `systemctl reload`.
  process.on("SIGHUP", () => {
    console.log(`\n  New pairing code (valid ~${ttlMin} min):  ${auth.refreshPairingCode()}\n`);
  });

  const shutdown = () => {
    claudeLogin.cancelActive(); // kill any in-flight `claude setup-token` PTY child
    void watcher.close();
    app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
