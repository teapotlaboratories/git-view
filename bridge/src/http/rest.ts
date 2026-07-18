import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { repoById } from "../config.js";
import { GitService } from "../git/gitService.js";
import { FileService } from "../git/fileService.js";
import { GitWrite } from "../git/gitWrite.js";
import { ApiError } from "../util/errors.js";
import { SessionManager } from "../claude/sessionManager.js";

/**
 * Browse routes are GET; editing routes are PUT/POST/DELETE.
 *
 * Reads at an arbitrary `ref` come from committed objects (immutable, read-only).
 * Writes act on the WORKING TREE (files on disk at the current checkout). With "direct, no prompts"
 * writes, path confinement (util/paths.ts) + auth are the security boundary — see docs/SECURITY.md.
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

  // Read a committed blob (at any ref). Read-only by nature.
  app.get<{ Params: { repo: string }; Querystring: { ref?: string; path: string } }>(
    "/api/repos/:repo/blob",
    async (req) => {
      const repo = getRepo(req.params.repo);
      if (!req.query.path) throw new ApiError("not_found", "path is required");
      const ref = req.query.ref ?? repo.defaultRef;
      return GitService.blob(repo, ref, req.query.path, cfg.limits.maxBlobBytes);
    },
  );

  // Read the WORKING-TREE version of a file (what the editor opens/edits).
  app.get<{ Params: { repo: string }; Querystring: { path: string } }>(
    "/api/repos/:repo/working",
    async (req) => {
      const repo = getRepo(req.params.repo);
      if (!req.query.path) throw new ApiError("not_found", "path is required");
      return FileService.readWorking(repo, req.query.path, cfg.limits.maxBlobBytes);
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

  app.get<{ Params: { repo: string } }>("/api/repos/:repo/sessions", async (req) => {
    const repo = getRepo(req.params.repo);
    return { sessions: await sessions.listForRepo(repo) };
  });

  // ---- WRITE surface: in-app editing (working tree, direct) ----

  type Enc = "utf-8" | "base64";

  // Save (overwrite/create) a file in the working tree.
  app.put<{ Params: { repo: string }; Body: { path: string; content: string; encoding?: Enc } }>(
    "/api/repos/:repo/blob",
    async (req) => {
      const repo = getRepo(req.params.repo);
      const { path, content, encoding } = req.body;
      if (!path) throw new ApiError("not_found", "path is required");
      return FileService.save(repo, path, content ?? "", encoding ?? "utf-8");
    },
  );

  // Create a new file (fails if it exists).
  app.post<{ Params: { repo: string }; Body: { path: string; content?: string; encoding?: Enc } }>(
    "/api/repos/:repo/file",
    async (req) => {
      const repo = getRepo(req.params.repo);
      const { path, content, encoding } = req.body;
      if (!path) throw new ApiError("not_found", "path is required");
      return FileService.create(repo, path, content ?? "", encoding ?? "utf-8");
    },
  );

  // Delete a file or directory.
  app.delete<{ Params: { repo: string }; Querystring: { path: string } }>(
    "/api/repos/:repo/file",
    async (req) => {
      const repo = getRepo(req.params.repo);
      if (!req.query.path) throw new ApiError("not_found", "path is required");
      return FileService.remove(repo, req.query.path);
    },
  );

  // Rename / move within the repo.
  app.post<{ Params: { repo: string }; Body: { from: string; to: string } }>(
    "/api/repos/:repo/rename",
    async (req) => {
      const repo = getRepo(req.params.repo);
      const { from, to } = req.body;
      if (!from || !to) throw new ApiError("not_found", "from and to are required");
      return FileService.rename(repo, from, to);
    },
  );

  // Git stage / commit / discard for the editor.
  app.post<{ Params: { repo: string }; Body: { paths: string[] } }>(
    "/api/repos/:repo/stage",
    async (req) => GitWrite.stage(getRepo(req.params.repo), req.body.paths ?? []),
  );

  app.post<{ Params: { repo: string }; Body: { message: string; paths?: string[] } }>(
    "/api/repos/:repo/commit",
    async (req) => GitWrite.commit(getRepo(req.params.repo), req.body.message, req.body.paths),
  );

  app.post<{ Params: { repo: string }; Body: { paths: string[] } }>(
    "/api/repos/:repo/discard",
    async (req) => GitWrite.discard(getRepo(req.params.repo), req.body.paths ?? []),
  );

  // TODO(phase-1): /diff (worktree|staged|base..head), /blame, /commits/:sha, /status.

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(err.toJSON());
    app.log.error(err);
    return reply.status(500).send({ error: "internal", message: "unexpected error" });
  });
}
