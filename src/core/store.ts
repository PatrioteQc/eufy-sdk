/**
 * Session persistence — so we log in (and clear 2FA) ONCE, then reuse the token
 * + ECDH key across runs, exactly like the app reuses its cached EcdhKey.
 *
 * Persisted: the auth token + user, the region shard, the device openudid, and
 * the negotiated ECDH key (shareKey + key-ident). On the next run we hydrate all
 * of it and go straight to data calls — no estimate_domain, no key/exchange, no
 * login, no 2FA — until the token expires (or a call 401s, which clears it).
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { RegionShard } from "../transport/http/mega-client.js";

/**
 * The persisted session record. Internal shape — a host supplies a `SessionStore`, never builds this.
 * @internal
 */
export interface PersistedSession {
  userId: string;
  authToken: string;
  geoKey?: string;
  region: RegionShard;
  openudid: string;
  /** This install's reported device model + media user-agent, generated once and reused. */
  phoneModel?: string;
  mediaUserAgent?: string;
  /** ECDH session: shareKey hex (32 chars) + the bound key-ident. */
  shareKey: string;
  keyIdent: string;
  /** Unix seconds when the auth token expires (0 = unknown). */
  tokenExpiresAt: number;
  savedAt: number;
}

export interface SessionStore {
  load(): PersistedSession | null;
  save(s: PersistedSession): void;
  clear(): void;
}

/** In-memory store (no persistence) — the default. */
export class MemorySessionStore implements SessionStore {
  private s: PersistedSession | null = null;
  load(): PersistedSession | null {
    return this.s;
  }
  save(s: PersistedSession): void {
    this.s = s;
  }
  clear(): void {
    this.s = null;
  }
}

/** JSON-file store, e.g. new FileSessionStore("./.eufy-session.json"). */
export class FileSessionStore implements SessionStore {
  constructor(private readonly path: string) {}
  load(): PersistedSession | null {
    try {
      return JSON.parse(readFileSync(this.path, "utf-8")) as PersistedSession;
    } catch {
      return null;
    }
  }
  save(s: PersistedSession): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* dir exists */
    }
    writeFileSync(this.path, JSON.stringify(s, null, 2), { mode: 0o600 });
  }
  clear(): void {
    try {
      rmSync(this.path);
    } catch {
      /* already gone */
    }
  }
}

/** A persisted session is usable if it has a token that isn't (near-)expired. */
export function isSessionValid(s: PersistedSession | null, skewSec = 300): boolean {
  if (!s?.authToken || !s.shareKey || !s.keyIdent) return false;
  if (s.tokenExpiresAt && s.tokenExpiresAt > 0) {
    return Math.floor(Date.now() / 1000) < s.tokenExpiresAt - skewSec;
  }
  return true;
}
