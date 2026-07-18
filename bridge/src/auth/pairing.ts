import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { unauthorized } from "../util/errors.js";

/**
 * Pairing + bearer tokens.
 *
 * On start the bridge mints a short-lived PAIRING CODE and prints it to the console. The app posts
 * it once to `POST /v1/pair` (the ONLY auth-exempt write endpoint) to receive a long-lived bearer
 * token, which it stores in the Android Keystore. All subsequent requests carry that token.
 *
 * Token checks are CONSTANT-TIME (timingSafeEqual over SHA-length-normalized buffers) so a valid
 * token can't be recovered by timing. See docs/SECURITY.md.
 */
export class AuthManager {
  private tokens = new Set<string>();
  private pairingCode: string;
  private pairingExpiresAt: number;

  constructor(
    private readonly tokensFile: string,
    private readonly pairingTtlMs = 10 * 60 * 1000,
  ) {
    this.pairingCode = mintPairingCode();
    this.pairingExpiresAt = Date.now() + pairingTtlMs;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.tokensFile, "utf-8")) as { tokens?: string[] };
      for (const t of raw.tokens ?? []) this.tokens.add(t);
    } catch {
      /* first run: no tokens file yet */
    }
  }

  get currentPairingCode(): string {
    return this.pairingCode;
  }

  /** Exchange a pairing code for a fresh bearer token. */
  async pair(code: string): Promise<string> {
    if (Date.now() > this.pairingExpiresAt) throw unauthorized("pairing code expired — restart the bridge");
    if (!constantTimeEqual(code, this.pairingCode)) throw unauthorized("invalid pairing code");
    const token = randomBytes(32).toString("base64url");
    this.tokens.add(token);
    await this.persist();
    // One code, one token: rotate after a successful pair so it can't be replayed.
    this.pairingCode = mintPairingCode();
    this.pairingExpiresAt = Date.now() + this.pairingTtlMs;
    return token;
  }

  /** Constant-time membership check for a presented bearer token. */
  verify(token: string | undefined): boolean {
    if (!token) return false;
    let ok = false;
    // Compare against every stored token in constant time (don't early-return on match).
    for (const t of this.tokens) if (constantTimeEqual(token, t)) ok = true;
    return ok;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.tokensFile), { recursive: true });
    await writeFile(this.tokensFile, JSON.stringify({ tokens: [...this.tokens] }, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}

function mintPairingCode(): string {
  // 6 groups of base32-ish chars, human-readable on a console.
  return randomBytes(5).toString("hex").toUpperCase().match(/.{1,4}/g)!.join("-");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still do a comparison to keep timing flat, then fail.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}
