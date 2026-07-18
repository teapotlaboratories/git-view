import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config.js";
import { ApiError } from "../util/errors.js";

/**
 * Phase 0/dev: a single static BRIDGE_TOKEN checked as a Bearer header.
 * Phase 4: replace with a pairing flow (QR/short code -> long-lived per-device bearer token,
 * signed with DEVICE_TOKEN_SECRET, stored in the Android Keystore). Interface stays the same.
 */

export function bearerToken(req: FastifyRequest): string | undefined {
  const h = req.headers["authorization"];
  if (!h || Array.isArray(h)) return undefined;
  const [scheme, token] = h.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

export function requireAuth(env: Env) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (req.url.startsWith("/api/pair") || req.url === "/api/health") return; // open endpoints
    const token = bearerToken(req);
    // TODO(phase-4): verify a signed device token instead of a shared secret.
    if (!token || (env.bridgeToken && token !== env.bridgeToken)) {
      throw new ApiError("unauthorized", "missing or invalid token");
    }
  };
}

export function registerPairing(app: FastifyInstance, _env: Env) {
  // TODO(phase-4): issue a pairing code out-of-band (print QR in the terminal),
  // then exchange it here for a signed device bearer token.
  app.post<{ Body: { pairingCode: string } }>("/api/pair", async () => {
    throw new ApiError("session_denied", "pairing not implemented yet (Phase 4)");
  });
}
