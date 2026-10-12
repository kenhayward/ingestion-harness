import { randomUUID } from 'node:crypto';
import { newSessionId, newToken, sha256 } from './tokens.js';

export type AccessRole = 'admin' | 'user';
export type TokenStatus = 'active' | 'expired' | 'revoked' | 'current-admin';

/** A token as listed to admins: never its hash or plaintext. */
export interface AccessToken {
  id: string;
  label: string;
  role: AccessRole;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  status: TokenStatus;
}

/** Who a valid session belongs to (`req.auth`). */
export interface SessionInfo {
  tokenId: string;
  role: AccessRole;
  label: string;
  expiresAt: string | null;
}

/** Sessions end after this long without use. */
export const SESSION_IDLE_MS = 7 * 86_400_000;
/** last_seen_at / last_used_at are written at most this often (not on every request). */
export const TOUCH_INTERVAL_MS = 5 * 60_000;

export type TokenChange = 'ok' | 'not_found' | 'admin';

/** Access tokens and the browser sessions they open. `PgAccessRepo` / `MemoryAccessRepo`. */
export interface AccessRepo {
  /** Replace the admin token (and end its sessions). Returns the new plaintext token. */
  rotateAdminToken(): Promise<string>;
  /** A new user token; `expiresInDays` null = never. The plaintext is returned only here. */
  createToken(
    label: string,
    expiresInDays: number | null,
  ): Promise<{ token: string; record: AccessToken }>;
  listTokens(): Promise<AccessToken[]>;
  /** Revoke a user token and end its sessions. 'admin': the admin token can't be revoked. */
  revokeToken(id: string): Promise<TokenChange>;
  deleteToken(id: string): Promise<TokenChange>;
  /** Open a session for an active token; null if the token is unknown, expired or revoked. */
  login(token: string): Promise<{ sessionId: string; session: SessionInfo } | null>;
  /** Validate (and occasionally touch) a session; null if it is no longer valid. */
  session(sessionId: string): Promise<SessionInfo | null>;
  logout(sessionId: string): Promise<void>;
}

interface TokenRow {
  id: string;
  label: string;
  role: AccessRole;
  hash: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** In-memory access repo for unit tests (injectable clock). */
export class MemoryAccessRepo implements AccessRepo {
  private readonly tokens = new Map<string, TokenRow>();
  private readonly sessions = new Map<string, { tokenId: string; lastSeen: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async rotateAdminToken(): Promise<string> {
    for (const row of [...this.tokens.values()].filter((t) => t.role === 'admin')) {
      this.removeToken(row.id);
    }
    const token = newToken();
    this.insert('admin', 'admin', token, null);
    return token;
  }

  async createToken(label: string, expiresInDays: number | null) {
    const token = newToken();
    const expires = expiresInDays === null ? null : this.now() + expiresInDays * 86_400_000;
    const row = this.insert(label, 'user', token, expires);
    return { token, record: this.view(row) };
  }

  async listTokens(): Promise<AccessToken[]> {
    return [...this.tokens.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => this.view(r));
  }

  async revokeToken(id: string): Promise<TokenChange> {
    const row = this.tokens.get(id);
    if (!row) return 'not_found';
    if (row.role === 'admin') return 'admin';
    row.revokedAt ??= this.now();
    this.endSessions(id);
    return 'ok';
  }

  async deleteToken(id: string): Promise<TokenChange> {
    const row = this.tokens.get(id);
    if (!row) return 'not_found';
    if (row.role === 'admin') return 'admin';
    this.removeToken(id);
    return 'ok';
  }

  async login(token: string) {
    const hash = sha256(token);
    const row = [...this.tokens.values()].find((t) => t.hash === hash);
    if (!row || !this.active(row)) return null;
    const sessionId = newSessionId();
    this.sessions.set(sha256(sessionId), { tokenId: row.id, lastSeen: this.now() });
    row.lastUsedAt = this.now();
    return { sessionId, session: this.info(row) };
  }

  async session(sessionId: string): Promise<SessionInfo | null> {
    const s = this.sessions.get(sha256(sessionId));
    const row = s && this.tokens.get(s.tokenId);
    const now = this.now();
    if (!s || !row || !this.active(row) || s.lastSeen + SESSION_IDLE_MS < now) return null;
    if (now - s.lastSeen >= TOUCH_INTERVAL_MS) s.lastSeen = now;
    if (row.lastUsedAt === null || now - row.lastUsedAt >= TOUCH_INTERVAL_MS) row.lastUsedAt = now;
    return this.info(row);
  }

  async logout(sessionId: string): Promise<void> {
    this.sessions.delete(sha256(sessionId));
  }

  private insert(label: string, role: AccessRole, token: string, expiresAt: number | null) {
    const row: TokenRow = {
      id: randomUUID(),
      label,
      role,
      hash: sha256(token),
      createdAt: this.now(),
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    };
    this.tokens.set(row.id, row);
    return row;
  }

  private active(row: TokenRow): boolean {
    return row.revokedAt === null && (row.expiresAt === null || row.expiresAt > this.now());
  }

  private removeToken(id: string) {
    this.tokens.delete(id);
    this.endSessions(id);
  }

  private endSessions(tokenId: string) {
    for (const [key, s] of this.sessions) if (s.tokenId === tokenId) this.sessions.delete(key);
  }

  private info(row: TokenRow): SessionInfo {
    return { tokenId: row.id, role: row.role, label: row.label, expiresAt: iso(row.expiresAt) };
  }

  private view(row: TokenRow): AccessToken {
    const status: TokenStatus =
      row.role === 'admin'
        ? 'current-admin'
        : row.revokedAt !== null
          ? 'revoked'
          : row.expiresAt !== null && row.expiresAt <= this.now()
            ? 'expired'
            : 'active';
    return {
      id: row.id,
      label: row.label,
      role: row.role,
      createdAt: new Date(row.createdAt).toISOString(),
      expiresAt: iso(row.expiresAt),
      revokedAt: iso(row.revokedAt),
      lastUsedAt: iso(row.lastUsedAt),
      status,
    };
  }
}
