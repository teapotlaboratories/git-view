export type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "bad_ref"
  | "path_denied"
  | "too_large"
  | "rate_limited"
  | "session_denied"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  bad_ref: 400,
  path_denied: 403,
  too_large: 413,
  rate_limited: 429,
  session_denied: 403,
  internal: 500,
};

export class ApiError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
  get status(): number {
    return STATUS[this.code];
  }
  toJSON() {
    return { error: this.code, message: this.message };
  }
}
