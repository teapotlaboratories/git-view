import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config, RepoConfig } from "../config.js";
import type { AuthManager } from "../auth/pairing.js";
import type { FileService } from "../git/fileService.js";
import type { GitWrite } from "../git/gitWrite.js";
import type { SessionManager } from "../claude/sessionManager.js";
import type { RemoteControlManager } from "../claude/remoteControl.js";
import { BridgeError, notFound, readOnly, tooLarge, unauthorized } from "../util/errors.js";
import { PROTOCOL_VERSION } from "../wire.js";
import * as gitSvc from "../git/gitService.js";
import { WORKTREE } from "../git/gitService.js";
import type {
  CommitBody, CreateFileBody, DiffKind, RenameBody, SaveFileBody, StageBody, StartSessionBody,
} from "../wire.js";

export interface RestDeps {
  cfg: Config;
  auth: AuthManager;
  files: FileService;
  gitWrite: GitWrite;
  sessions: SessionManager;
  remote: RemoteControlManager;
}

const AUTH_EXEMPT = new Set(["/v1/health", "/v1/pair"]);

export async function buildServer(deps: RestDeps): Promise<FastifyInstance> {
  const { cfg, auth, files, gitWrite, sessions, remote } = deps;

  // The body limit must clear the write cap AFTER base64 expansion (~1.37x), or a large binary save is
  // rejected by the body limit before the write-size check ever runs. No CORS: the only client is the
  // native app (bearer token in a header, not a browser), so CORS would be dead weight + surface.
  const bodyLimit = Math.max(cfg.bodyLimitBytes, Math.ceil(cfg.writeSizeCapBytes * 1.4));
  const app = Fastify({ bodyLimit, logger: false });

  // ---- auth on every request except the exempt endpoints --------------------
  app.addHook("onRequest", async (req) => {
    const url = req.url.split("?")[0] ?? req.url;
    if (AUTH_EXEMPT.has(url)) return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!auth.verify(token)) throw unauthorized();
  });

  // ---- uniform error translation -------------------------------------------
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof BridgeError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if ((err as { statusCode?: number }).statusCode === 413) {
      return reply.code(413).send({ error: { code: "too_large", message: "request body too large" } });
    }
    return reply.code(500).send({ error: { code: "internal", message: (err as Error).message } });
  });

  const repo = (req: FastifyRequest): RepoConfig => {
    const id = (req.params as { repo: string }).repo;
    const r = cfg.repoById(id);
    if (!r) throw notFound(`repo not found: ${id}`);
    return r;
  };
  const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;

  // ---- meta -----------------------------------------------------------------
  app.get("/v1/health", async () => ({ ok: true, protocol: PROTOCOL_VERSION, bridge: "0.1.0" }));

  app.post("/v1/pair", async (req) => {
    const code = (req.body as { code?: string })?.code ?? "";
    return { token: await auth.pair(code) };
  });

  app.get("/v1/repos", async () => ({
    repos: cfg.repos.map((r) => ({
      id: r.id, name: r.name, defaultBranch: "main", provider: r.provider, profile: r.profile,
    })),
  }));

  // ---- read -----------------------------------------------------------------
  app.get("/v1/repos/:repo/refs", async (req) => gitSvc.getRefs(repo(req).path));

  app.get("/v1/repos/:repo/tree", async (req, reply) => {
    const r = repo(req); const { ref, path } = q(req);
    const resolved = await gitSvc.resolveRef(r.path, ref);
    setCache(reply, resolved);
    return gitSvc.listTree(r.path, resolved, path ?? "");
  });

  app.get("/v1/repos/:repo/blob", async (req, reply) => {
    const r = repo(req); const { ref, path } = q(req);
    if (!path) throw notFound("path is required");
    const resolved = await gitSvc.resolveRef(r.path, ref);
    setCache(reply, resolved);
    return gitSvc.readBlob(r.path, resolved, path);
  });

  app.get("/v1/repos/:repo/log", async (req) => {
    const r = repo(req); const { ref, path, limit } = q(req);
    const resolved = await gitSvc.resolveRef(r.path, ref);
    return { commits: await gitSvc.log(r.path, resolved, path, Number(limit ?? 50)) };
  });

  app.get("/v1/repos/:repo/diff", async (req) => {
    const r = repo(req); const { kind, ref, path } = q(req);
    return { diff: await gitSvc.diff(r.path, (kind ?? "worktree") as DiffKind, ref ?? WORKTREE, path) };
  });

  app.get("/v1/repos/:repo/blame", async (req) => {
    const r = repo(req); const { ref, path } = q(req);
    if (!path) throw notFound("path is required");
    return { blame: await gitSvc.blame(r.path, await gitSvc.resolveRef(r.path, ref), path) };
  });

  app.get("/v1/repos/:repo/show", async (req) => {
    const r = repo(req); const { ref } = q(req);
    return { show: await gitSvc.show(r.path, ref ?? "HEAD") };
  });

  app.get("/v1/repos/:repo/status", async (req) => ({ status: await gitSvc.status(repo(req).path) }));

  // ---- write (working tree only; historical refs are read-only) -------------
  const assertWorktree = (req: FastifyRequest) => {
    const ref = q(req)["ref"];
    if (ref && ref !== WORKTREE) throw readOnly();
  };

  app.put("/v1/repos/:repo/file", async (req) => {
    assertWorktree(req);
    const r = repo(req); const path = q(req)["path"];
    if (!path) throw notFound("path is required");
    const body = req.body as SaveFileBody;
    return files.save(r.id, r.path, path, body.content, body.encoding, "app");
  });

  app.post("/v1/repos/:repo/file", async (req) => {
    const r = repo(req); const body = req.body as CreateFileBody;
    return files.create(r.id, r.path, body.path, body.content, body.encoding, "app");
  });

  app.delete("/v1/repos/:repo/file", async (req) => {
    const r = repo(req); const path = q(req)["path"];
    if (!path) throw notFound("path is required");
    return files.remove(r.id, r.path, path, "app");
  });

  app.post("/v1/repos/:repo/rename", async (req) => {
    const r = repo(req); const body = req.body as RenameBody;
    return files.renamePath(r.id, r.path, body.from, body.to, "app");
  });

  app.post("/v1/repos/:repo/stage", async (req) => {
    const r = repo(req); const body = req.body as StageBody;
    return gitWrite.stage(r.id, r.path, body.paths, "app");
  });

  app.post("/v1/repos/:repo/commit", async (req) => {
    const r = repo(req); const body = req.body as CommitBody;
    return gitWrite.commit(r.id, r.path, body.message, body.paths, "app");
  });

  app.post("/v1/repos/:repo/discard", async (req) => {
    const r = repo(req); const body = req.body as StageBody;
    return gitWrite.discard(r.id, r.path, body.paths, "app");
  });

  // ---- sessions -------------------------------------------------------------
  app.get("/v1/repos/:repo/sessions", async (req) => ({
    sessions: await sessions.listForRepo(repo(req)),
  }));

  app.post("/v1/repos/:repo/sessions", async (req) => {
    const r = repo(req); const body = req.body as StartSessionBody;
    if (body.provider === "remote-control") return remote.start(r);
    // local-sdk: the actual prompt/stream happens over the WebSocket; here we just acknowledge.
    return { sessionId: body.resume ?? "pending", provider: "local-sdk" as const };
  });

  return app;
}

/** Immutable object ids get a strong ETag + long cache; the working tree is never cached. */
function setCache(reply: FastifyReply, resolved: string): void {
  if (resolved === WORKTREE) {
    reply.header("Cache-Control", "no-cache");
  } else {
    reply.header("ETag", `"${resolved}"`);
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
  }
}

// keep tooLarge referenced for future streaming-write use
void tooLarge;
