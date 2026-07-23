import { readFileSync } from "node:fs";

/**
 * The bridge version, read from package.json at runtime so `/v1/health` and the MCP server always report
 * the released version — instead of a hardcoded string that silently drifts on every version bump.
 * `../package.json` resolves the same from src/ (dev), dist/ (build), and /opt/gitview-bridge/ (.deb),
 * since version.{ts,js} sits one level under each root.
 */
export const BRIDGE_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
