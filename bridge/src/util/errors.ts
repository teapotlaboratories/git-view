import type { ErrorCode } from "../wire.js";

/** An error carrying a wire ErrorCode + HTTP status, so routes can translate uniformly. */
export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export const unauthorized = (m = "missing or invalid token") => new BridgeError("unauthorized", 401, m);
export const forbidden = (m = "not allowed") => new BridgeError("forbidden", 403, m);
export const notFound = (m = "not found") => new BridgeError("not_found", 404, m);
export const pathEscape = (m = "path escaped the repository root") => new BridgeError("path_escape", 400, m);
export const readOnly = (m = "writes are not allowed at a historical ref") => new BridgeError("read_only", 409, m);
export const tooLarge = (m = "payload exceeded the configured cap") => new BridgeError("too_large", 413, m);
export const gitError = (m: string) => new BridgeError("git_error", 422, m);
export const internal = (m = "internal error") => new BridgeError("internal", 500, m);
