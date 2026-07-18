import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { repoById } from "../config.js";
import { GitService } from "../git/gitService.js";
import { ApiError } from "../util/errors.js";
import { SessionManager } from "../claude/sessionManager.js";

/**
 * All browse routes are GET and read-only. There are intentionally no write verbs here —
 * the browse path cannot mutate a repo (see docs/SECURITY.md).
 */
export function registerRest(app: FastifyInstance, cfg: Config, sessions: SessionManager) {
  const getRepo = (id: string) => {
    const r = repoById(cfg, id);
    if (!r) throw new ApiError("not_found", `no such repo: ${id}`);
    return r;
  };

  app.get("/api/health", async () => ({ ok: true, name: "gitview-bridge", version: "0.1.0" }));

  app.get("/api/repos", async () => ({
    repos: cfg.repos.map((r) => ({ id: r.id, name: r.name, defaultRef: r.defaultRef })),
  }));

  app.get<{ Params: { repo: string } }>("/api/repos/:repo/refs", async (req) =>
    GitService.refs(getRepo(req.params.repo)),
  );

  app.get<{ Params: { repo: string }; Querystring: { ref?: string; path?: string } }>(
    "/api/repos/:repo/tree",
    async (req) => {
      const repo = getRepo(req.params.repo);
      const ref = req.query.ref ?? repo.defaultRef;
      const entries = await GitService.tree(repo, ref, req.query.path ?? "");
      return { ref, path: req.query.path ?? "", entries };
    },
  );

  app.get<{ Params: { repo: string }; Querystring: { ref?: string; path: string } }>(
    "/api/repos/:repo/blob",
    async (req) => {
      const repo = getRepo(req.params.repo);
      if (!req.query.path) throw new ApiError("not_found", "path is required");
      const ref = req.query.ref ?? repo.defaultRef;
      return GitService.blob(repo, ref, req.query.path, cfg.limits.maxBlobBytes);
    },
  );

  app.get<{ Params: { repo: string }; Querystring: { ref?: string; path?: string; limit?: string } }>(
    "/api/repos/:repo/log",
    async (req) => {
      const repo = getRepo(req.params.repo);
      const ref = req.query.ref ?? repo.defaultRef;
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      return { commits: await GitService.log(repo, ref, req.query.path, limit) };
    },
  );

  // Lists Claude sessions discoverable for this repo's directory (~/.claude/projects/<cwd>/).
  app.get<{ Params: { repo: string } }>("/api/repos/:repo/sessions", async (req) => {
    const repo = getRepo(req.params.repo);
    return { sessions: await sessions.listForRepo(repo) };
  });

  // TODO(phase-1): /diff (worktree|staged|base..head), /blame, /commits/:sha, /status.

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(err.toJSON());
    app.log.error(err);
    return reply.status(500).send({ error: "internal", message: "unexpected error" });
  });
}
