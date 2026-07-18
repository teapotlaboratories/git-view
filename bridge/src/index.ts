import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig, loadEnv } from "./config.js";
import { registerRest } from "./http/rest.js";
import { registerPairing, requireAuth } from "./auth/pairing.js";
import { SessionManager } from "./claude/sessionManager.js";
import { attachLiveChannel } from "./ws/liveChannel.js";

async function main() {
  const env = loadEnv();
  const cfg = loadConfig(process.env.GITVIEW_CONFIG ?? "config.yaml");
  const sessions = new SessionManager(cfg);

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true }); // tighten in production
  app.addHook("onRequest", requireAuth(env));

  registerPairing(app, env);
  registerRest(app, cfg, sessions);

  await app.listen({ port: env.port, host: env.host });
  attachLiveChannel(app.server, cfg, env, sessions);

  app.log.info(
    `GitView bridge on http://${env.host}:${env.port} — ${cfg.repos.length} repo(s). ` +
      `WebSocket at /ws. Expose privately with: tailscale serve --bg ${env.port}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
