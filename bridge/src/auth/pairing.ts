import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { unauthorized } from "../util/errors.js";

/**
 * Pairing + per-device bearer tokens (ADR-035, Option B).
 *
 * On start the bridge mints a short-lived PAIRING CODE and prints it to the console. The app posts it
 * once to `POST /v1/pair` (the ONLY auth-exempt write endpoint) to receive a long-lived bearer token,
 * which it stores in the Android Keystore. The code is NEVER persisted and NEVER returned over the
 * network — restricting it to the local console/journal is what makes *host access* the authentication.
 *
 * Tokens are `<deviceId>.<secret>` and the store keeps only **sha256(secret)**, so the state file no
 * longer contains anything that grants access if it leaves the host (a backup, a synced dotfile, a bad
 * chmod). A plain SHA-256 is the right primitive here: the secret is 32 random bytes, not a human
 * password, so there is nothing to brute-force and a slow KDF would only add latency per request.
 *
 * Lookup is by id (O(1)) and then ONE constant-time compare of the hash. This makes *id* existence
 * observable by timing — accepted deliberately, ids are not secrets — while the secret itself stays
 * guarded by `timingSafeEqual`. Legacy bare-string tokens (pre-ADR-035) still verify, via the old
 * flat-timing O(n) scan, so upgrading never forces a re-pair. See docs/SECURITY.md.
 */

export interface DeviceRecord {
  id: string;
  label: string;
  createdAt: string; // ISO-8601
  lastSeenAt: string; // ISO-8601
  tokenHash: string; // sha256(secret), hex
}

/** Who is behind a request. Returned by `authenticate`; stamped on live connections + audit entries. */
export interface DeviceIdentity {
  id: string;
  label: string;
}

/** Public view — never carries `tokenHash`. */
export interface DeviceSummary {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  legacy: boolean;
}

/** All pre-ADR-035 bare tokens share one synthetic id; they are indistinguishable by construction. */
export const LEGACY_DEVICE_ID = "legacy";
const LEGACY_LABEL = "unknown legacy device(s)";
/** `lastSeenAt` must never fsync per request — one soak run issued 59 polls in 30s. Coalesce writes. */
const LAST_SEEN_FLUSH_MS = 10_000;
const MAX_LABEL_LEN = 64;

export class AuthManager {
  private devices = new Map<string, DeviceRecord>();
  private legacyTokens = new Set<string>();
  private pairingCode: string;
  private pairingExpiresAt: number;
  private lastSeenDirty = false;
  /** Serializes store writes; see persist(). */
  private writeChain: Promise<void> = Promise.resolve();
  private writeSeq = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tokensFile: string,
    private readonly pairingTtlMs = 10 * 60 * 1000,
  ) {
    this.pairingCode = mintPairingCode();
    this.pairingExpiresAt = Date.now() + pairingTtlMs;
  }

  /**
   * Read the store. The three outcomes are deliberately distinct, because "there is no file yet" and
   * "there is a file and I cannot read it" demand opposite responses: the first is a normal first run,
   * the second means every device is about to look revoked and somebody must be told.
   */
  async load(): Promise<"loaded" | "absent" | "unreadable"> {
    let raw: string;
    try {
      raw = await readFile(this.tokensFile, "utf-8");
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
    }
    try {
      const parsed = JSON.parse(raw) as { devices?: DeviceRecord[]; tokens?: string[] };
      for (const d of parsed.devices ?? []) if (d?.id) this.devices.set(d.id, d);
      // Pre-ADR-035 file (or the legacy remnant of a migrated one): keep honouring these.
      for (const t of parsed.tokens ?? []) this.legacyTokens.add(t);
      return "loaded";
    } catch {
      return "unreadable";
    }
  }

  get currentPairingCode(): string {
    return this.pairingCode;
  }

  /**
   * Mint a fresh pairing code at runtime (e.g. on SIGHUP) and reset its TTL — no restart needed, and
   * already-issued tokens are untouched. Returns the new code so the caller can print it to the
   * console/journal (the code is NEVER exposed over the network).
   */
  refreshPairingCode(): string {
    this.pairingCode = mintPairingCode();
    this.pairingExpiresAt = Date.now() + this.pairingTtlMs;
    return this.pairingCode;
  }

  /** Exchange a pairing code for a fresh device token (`<id>.<secret>`). */
  async pair(code: string, label?: string): Promise<string> {
    if (Date.now() > this.pairingExpiresAt)
      throw unauthorized("pairing code expired — get a fresh code from the bridge console (SIGHUP; no restart needed)");
    if (!constantTimeEqual(code, this.pairingCode)) throw unauthorized("invalid pairing code");

    const id = `dv_${randomBytes(6).toString("base64url")}`;
    const secret = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    this.devices.set(id, {
      id,
      label: sanitizeLabel(label),
      createdAt: now,
      lastSeenAt: now,
      tokenHash: sha256Hex(secret),
    });
    await this.persist();

    // One code, one token: rotate after a successful pair so it can't be replayed.
    this.pairingCode = mintPairingCode();
    this.pairingExpiresAt = Date.now() + this.pairingTtlMs;
    return `${id}.${secret}`;
  }

  /**
   * Resolve a presented bearer token to the device behind it, or `null`. Also refreshes `lastSeenAt`
   * (coalesced — see LAST_SEEN_FLUSH_MS).
   */
  authenticate(token: string | undefined): DeviceIdentity | null {
    if (!token) return null;

    const dot = token.indexOf(".");
    if (dot > 0) {
      const rec = this.devices.get(token.slice(0, dot));
      // A base64url secret never contains ".", so a dotted token is never a legacy one — no fallthrough.
      if (!rec) return null;
      if (!constantTimeEqual(sha256Hex(token.slice(dot + 1)), rec.tokenHash)) return null;
      this.touch(rec);
      return { id: rec.id, label: rec.label };
    }

    // Legacy bare token: same flat-timing scan as before (no early return on match).
    let ok = false;
    for (const t of this.legacyTokens) if (constantTimeEqual(token, t)) ok = true;
    return ok ? { id: LEGACY_DEVICE_ID, label: LEGACY_LABEL } : null;
  }

  /** Constant-time membership check for a presented bearer token. */
  verify(token: string | undefined): boolean {
    return this.authenticate(token) !== null;
  }

  /** Devices for `GET /v1/devices`. Legacy tokens collapse into one synthetic, revocable entry. */
  list(): DeviceSummary[] {
    const out: DeviceSummary[] = [...this.devices.values()]
      .map(({ id, label, createdAt, lastSeenAt }) => ({ id, label, createdAt, lastSeenAt, legacy: false }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (this.legacyTokens.size > 0) {
      out.push({
        id: LEGACY_DEVICE_ID,
        label: `${LEGACY_LABEL} (${this.legacyTokens.size})`,
        createdAt: "",
        lastSeenAt: "",
        legacy: true,
      });
    }
    return out;
  }

  /**
   * Un-register a device so its token stops working. Revoking `legacy` drops ALL pre-ADR-035 bare
   * tokens at once — they carry no identity, so they cannot be pruned individually. Returns false if
   * the id was unknown. The caller must also close that device's live sockets (see LiveChannel).
   */
  /**
   * @returns how many credentials were dropped — 0 when the id is unknown.
   *
   * A COUNT, not a flag, because `legacy` clears a whole bucket in one irreversible call and the operator
   * has no other way to learn how many devices they just cut off. It used to return a boolean, so
   * `gitview-bridgectl revoke legacy` said the same thing whether it dropped one token or twenty-one.
   */
  async revoke(id: string): Promise<number> {
    if (id === LEGACY_DEVICE_ID) {
      const n = this.legacyTokens.size;
      if (n === 0) return 0;
      this.legacyTokens.clear();
      await this.persist();
      return n;
    }
    if (!this.devices.delete(id)) return 0;
    await this.persist();
    return 1;
  }

  /**
   * Re-read the store from disk, returning the ids that are no longer present. Lets an operator edit
   * `tokens.json` out of band — `gitview-bridgectl revoke` does exactly that — and have it take effect
   * without a restart. The caller is expected to disconnect the returned devices, matching what
   * `DELETE /v1/devices/:id` already does.
   *
   * A pending `lastSeenAt` flush is dropped rather than written — but only to avoid a redundant write:
   * once the maps are replaced, a late flush would persist the POST-reload state anyway.
   *
   * The race this does NOT close: a flush landing between the external edit and this signal writes the
   * pre-edit device list straight back, resurrecting the revoked device. `gitview-bridgectl revoke`
   * signals immediately after writing, so the window is milliseconds, but it is not zero. Closing it
   * properly would mean the flush merging into the on-disk store rather than overwriting it.
   */
  async reload(): Promise<string[]> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Cleared before we can fail: on the refusal path this drops a pending lastSeenAt update, which is
    // best-effort telemetry and not worth complicating the restore for.
    this.lastSeenDirty = false;
    const before = new Set([...this.devices.keys(), ...(this.legacyTokens.size > 0 ? [LEGACY_DEVICE_ID] : [])]);
    // Read into SCRATCH state first. Clearing and then loading meant any read failure — an unreadable
    // file, malformed JSON — silently emptied the store, and every device read as "revoked". That is
    // exactly what happened in testing: a CLI revoke run under sudo left the file root-owned, the
    // bridge (running as the install user) hit EACCES, and one revoke of a throwaway wiped every
    // device and all legacy tokens. A store we cannot read must change NOTHING.
    const keptDevices = this.devices;
    const keptLegacy = this.legacyTokens;
    this.devices = new Map();
    this.legacyTokens = new Set();
    // Anything but a clean load leaves the store exactly as it was — including a MISSING file, which
    // must not be read as "the operator revoked everything".
    const outcome = await this.load();
    if (outcome !== "loaded") {
      this.devices = keptDevices;
      this.legacyTokens = keptLegacy;
      throw new Error(`refusing to reload: ${this.tokensFile} is ${outcome} — store left intact`);
    }
    const after = new Set([...this.devices.keys(), ...(this.legacyTokens.size > 0 ? [LEGACY_DEVICE_ID] : [])]);
    return [...before].filter((id) => !after.has(id));
  }

  /** Flush a pending `lastSeenAt` update and stop the timer (call on shutdown). */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.lastSeenDirty) await this.persist();
  }

  private touch(rec: DeviceRecord): void {
    rec.lastSeenAt = new Date().toISOString();
    this.lastSeenDirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.persist().catch(() => {}); // a lastSeen write must never take the bridge down
    }, LAST_SEEN_FLUSH_MS);
    this.flushTimer.unref?.(); // never hold the process open just to record lastSeen
  }

  /**
   * Write via tmp+rename so a crash or a concurrent read never sees a half-written store.
   *
   * Writes are SERIALIZED through a chain: a `pair()`/`revoke()` and a coalesced `lastSeenAt` flush can
   * overlap, and two concurrent writers sharing one tmp path would interleave as
   * write→write→rename→rename, the second rename failing ENOENT. Chaining also fixes the ordering, so
   * the last caller's snapshot is the one left on disk. The tmp name is unique per write as well, so a
   * stale `.tmp` from a killed process can never be mistaken for an in-flight one.
   */
  private persist(): Promise<void> {
    this.lastSeenDirty = false;
    const snapshot = JSON.stringify(
      { devices: [...this.devices.values()], tokens: [...this.legacyTokens] },
      null,
      2,
    );
    const seq = ++this.writeSeq;
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.tokensFile), { recursive: true });
      const tmp = `${this.tokensFile}.${process.pid}.${seq}.tmp`;
      try {
        await writeFile(tmp, snapshot, { encoding: "utf-8", mode: 0o600 });
        await rename(tmp, this.tokensFile);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {}); // never leave a partial tmp behind
        throw err;
      }
    };
    // `.then(run, run)` so one failed write doesn't wedge every subsequent one.
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }
}

function mintPairingCode(): string {
  // 6 groups of base32-ish chars, human-readable on a console.
  return randomBytes(5).toString("hex").toUpperCase().match(/.{1,4}/g)!.join("-");
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Labels are shown in the app's device list — keep them short and free of control characters. */
function sanitizeLabel(label: string | undefined): string {
  const clean = (label ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean.length > 0 ? clean.slice(0, MAX_LABEL_LEN) : "device";
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
