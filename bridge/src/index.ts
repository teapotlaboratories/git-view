import { loadConfig } from "./config.js";
import { AuthManager } from "./auth/pairing.js";
import { AuditLog } from "./util/audit.js";
import { FileService } from "./git/fileService.js";
import { GitWrite } from "./git/gitWrite.js";
import { SessionManager } from "./claude/sessionManager.js";
import { RemoteControlManager } from "./claude/remoteControl.js";
import { buildServer } from "./http/rest.js";
import { LiveChannel } from "./ws/liveChannel.js";
import { RepoWatcher } from "./git/repoWatcher.js";

async function main(): Promise<void> {
  const configPath = process.env["GITVIEW_CONFIG"] ?? process.argv[2] ?? "./config.yaml";
  const cfg = await loadConfig(configPath);

  const audit = new AuditLog(cfg.auditFile);
  const auth = new AuthManager(cfg.tokensFile);
  await auth.load();

  const files = new FileService(cfg.writeSizeCapBytes, audit);
  const gitWrite = new GitWrite(audit);
  const sessions = new SessionManager(cfg.claude, files, gitWrite);
  const remote = new RemoteControlManager(cfg.claude.sandbox.enabled);

  const app = await buildServer({ cfg, auth, files, gitWrite, sessions, remote });
  await app.listen({ host: cfg.bind, port: cfg.port });

  const live = new LiveChannel(cfg, auth, sessions);
  live.attach(app.server);

  // Push working-tree/git-state changes to connected apps so the UI stays live.
  const watcher = new RepoWatcher(cfg.repos, (repo, paths) => live.broadcastRepoChanged(repo, paths));
  watcher.start();

  console.log(`\nGitView bridge listening on http://${cfg.bind}:${cfg.port}`);
  console.log(`Repos: ${cfg.repos.map((r) => r.id).join(", ")}`);
  console.log(`\n  Pairing code (valid ~10 min):  ${auth.currentPairingCode}\n`);
  console.log("Front this with Tailscale Serve — never expose a read/write bridge publicly. See docs/SECURITY.md.");

  const shutdown = () => {
    remote.stopAll();
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
