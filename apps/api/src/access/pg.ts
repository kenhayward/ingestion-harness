import type pg from 'pg';
import type { AccessRepo, AccessRole, AccessToken, SessionInfo, TokenChange } from './repo.js';
import { newSessionId, newToken, sha256 } from './tokens.js';

const STATUS = `CASE WHEN t.role = 'admin' THEN 'current-admin'
                     WHEN t.revoked_at IS NOT NULL THEN 'revoked'
                     WHEN t.expires_at IS NOT NULL AND t.expires_at <= now() THEN 'expired'
                     ELSE 'active' END`;
const ACTIVE = `t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())`;

interface TokenRow {
  id: string;
  label: string;
  role: AccessRole;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  status: AccessToken['status'];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toToken(r: TokenRow): AccessToken {
  return {
    id: r.id,
    label: r.label,
    role: r.role,
    createdAt: r.created_at.toISOString(),
    expiresAt: iso(r.expires_at),
    revokedAt: iso(r.revoked_at),
    lastUsedAt: iso(r.last_used_at),
    status: r.status,
  };
}

function toInfo(r: { id: string; role: AccessRole; label: string; expires_at: Date | null }) {
  const info: SessionInfo = {
    tokenId: r.id,
    role: r.role,
    label: r.label,
    expiresAt: iso(r.expires_at),
  };
  return info;
}

/** Access tokens and sessions in Postgres (migration 0007). Semantics match MemoryAccessRepo. */
export class PgAccessRepo implements AccessRepo {
  constructor(private readonly pool: pg.Pool) {}

  async rotateAdminToken(): Promise<string> {
    const token = newToken();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM access_tokens WHERE role = 'admin'`); // sessions cascade
      await client.query(
        `INSERT INTO access_tokens (label, role, token_hash) VALUES ('admin', 'admin', $1)`,
        [sha256(token)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return token;
  }

  async createToken(label: string, expiresInDays: number | null) {
    const token = newToken();
    const { rows } = await this.pool.query<TokenRow>(
      `WITH t AS (
         INSERT INTO access_tokens (label, role, token_hash, expires_at)
         VALUES ($1, 'user', $2,
                 CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(days => $3::int) END)
         RETURNING *)
       SELECT t.*, ${STATUS} AS status FROM t`,
      [label, sha256(token), expiresInDays],
    );
    return { token, record: toToken(rows[0]!) };
  }

  async listTokens(): Promise<AccessToken[]> {
    const { rows } = await this.pool.query<TokenRow>(
      `SELECT t.*, ${STATUS} AS status FROM access_tokens t ORDER BY t.created_at DESC`,
    );
    return rows.map(toToken);
  }

  async revokeToken(id: string): Promise<TokenChange> {
    return this.change(id, async () => {
      await this.pool.query(
        `UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`,
        [id],
      );
      await this.pool.query(`DELETE FROM sessions WHERE token_id = $1`, [id]);
    });
  }

  async deleteToken(id: string): Promise<TokenChange> {
    return this.change(id, async () => {
      await this.pool.query(`DELETE FROM access_tokens WHERE id = $1`, [id]); // sessions cascade
    });
  }

  async login(token: string) {
    const { rows } = await this.pool.query<{
      id: string;
      role: AccessRole;
      label: string;
      expires_at: Date | null;
    }>(
      `UPDATE access_tokens t SET last_used_at = now()
        WHERE t.token_hash = $1 AND ${ACTIVE}
        RETURNING t.id, t.role, t.label, t.expires_at`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row) return null;
    const sessionId = newSessionId();
    await this.pool.query(`INSERT INTO sessions (id_hash, token_id) VALUES ($1, $2)`, [
      sha256(sessionId),
      row.id,
    ]);
    return { sessionId, session: toInfo(row) };
  }

  async session(sessionId: string): Promise<SessionInfo | null> {
    const idHash = sha256(sessionId);
    const { rows } = await this.pool.query<{
      id: string;
      role: AccessRole;
      label: string;
      expires_at: Date | null;
      stale: boolean;
    }>(
      `SELECT t.id, t.role, t.label, t.expires_at,
              s.last_seen_at < now() - interval '5 minutes' AS stale
         FROM sessions s JOIN access_tokens t ON t.id = s.token_id
        WHERE s.id_hash = $1 AND ${ACTIVE}
          AND s.last_seen_at > now() - interval '7 days'`,
      [idHash],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.stale) {
      // Touch at most every 5 minutes: browsing shouldn't write on every request.
      await this.pool.query(`UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1`, [
        idHash,
      ]);
      await this.pool.query(`UPDATE access_tokens SET last_used_at = now() WHERE id = $1`, [
        row.id,
      ]);
    }
    return toInfo(row);
  }

  async logout(sessionId: string): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE id_hash = $1`, [sha256(sessionId)]);
  }

  private async change(id: string, apply: () => Promise<void>): Promise<TokenChange> {
    const { rows } = await this.pool.query<{ role: AccessRole }>(
      `SELECT role FROM access_tokens WHERE id::text = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return 'not_found';
    if (row.role === 'admin') return 'admin';
    await apply();
    return 'ok';
  }
}
