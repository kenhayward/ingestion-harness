import { describe, expect, it } from 'vitest';
import { MemoryAccessRepo, SESSION_IDLE_MS } from '../src/access/repo.js';
import { newToken, sha256 } from '../src/access/tokens.js';

const DAY = 86_400_000;

function setup() {
  let now = Date.parse('2026-10-12T00:00:00Z');
  const repo = new MemoryAccessRepo(() => now);
  return { repo, advance: (ms: number) => (now += ms) };
}

describe('access tokens', () => {
  it('generates long random tokens and hashes with SHA-256', () => {
    const t = newToken();
    expect(t).toMatch(/^ih_[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(t);
    expect(sha256('x')).toBe('2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
  });

  it('rotates the admin token: the old one and its sessions stop working, users survive', async () => {
    const { repo } = setup();
    const admin1 = await repo.rotateAdminToken();
    const adminLogin = await repo.login(admin1);
    expect(adminLogin?.session.role).toBe('admin');
    const { token: userToken } = await repo.createToken('Ken – laptop', 30);
    const userLogin = (await repo.login(userToken))!;

    const admin2 = await repo.rotateAdminToken();
    expect(admin2).not.toBe(admin1);
    expect(await repo.login(admin1)).toBeNull();
    expect(await repo.session(adminLogin!.sessionId)).toBeNull();
    expect((await repo.login(admin2))?.session.role).toBe('admin');
    expect(await repo.session(userLogin.sessionId)).toMatchObject({ role: 'user' });
    expect((await repo.listTokens()).filter((t) => t.role === 'admin')).toHaveLength(1);
  });

  it('expires user tokens and their sessions', async () => {
    const { repo, advance } = setup();
    const { token, record } = await repo.createToken('short', 1);
    expect(record).toMatchObject({ role: 'user', status: 'active' });
    expect(record.expiresAt).toBe('2026-10-13T00:00:00.000Z');
    const { sessionId } = (await repo.login(token))!;
    advance(DAY + 1);
    expect(await repo.session(sessionId)).toBeNull();
    expect(await repo.login(token)).toBeNull();
    expect((await repo.listTokens())[0]!.status).toBe('expired');
  });

  it('ends sessions idle for more than 7 days, but not used ones', async () => {
    const { repo, advance } = setup();
    const { token } = await repo.createToken('never', null);
    const idle = (await repo.login(token))!.sessionId;
    const used = (await repo.login(token))!.sessionId;
    advance(SESSION_IDLE_MS - DAY);
    expect(await repo.session(used)).not.toBeNull(); // touched
    advance(DAY + 1);
    expect(await repo.session(idle)).toBeNull();
    expect(await repo.session(used)).not.toBeNull();
  });

  it('revokes at once and deletes', async () => {
    const { repo } = setup();
    const { token, record } = await repo.createToken('temp', 7);
    const { sessionId } = (await repo.login(token))!;
    expect(await repo.revokeToken(record.id)).toBe('ok');
    expect(await repo.session(sessionId)).toBeNull();
    expect(await repo.login(token)).toBeNull();
    expect((await repo.listTokens())[0]!.status).toBe('revoked');
    expect(await repo.deleteToken(record.id)).toBe('ok');
    expect(await repo.listTokens()).toEqual([]);
  });

  it('protects the current admin token and reports unknown ids', async () => {
    const { repo } = setup();
    await repo.rotateAdminToken();
    const [admin] = await repo.listTokens();
    expect(admin!.status).toBe('current-admin');
    expect(await repo.revokeToken(admin!.id)).toBe('admin');
    expect(await repo.deleteToken(admin!.id)).toBe('admin');
    expect(await repo.revokeToken('nope')).toBe('not_found');
    expect(await repo.deleteToken('nope')).toBe('not_found');
  });

  it('never exposes hashes, records last use and logs out', async () => {
    const { repo } = setup();
    const { token } = await repo.createToken('a', null);
    const { sessionId } = (await repo.login(token))!;
    const [t] = await repo.listTokens();
    expect(Object.keys(t!).sort()).toEqual(
      ['createdAt', 'expiresAt', 'id', 'label', 'lastUsedAt', 'revokedAt', 'role', 'status'].sort(),
    );
    expect(t!.lastUsedAt).not.toBeNull();
    await repo.logout(sessionId);
    expect(await repo.session(sessionId)).toBeNull();
    expect(await repo.login('ih_wrong')).toBeNull();
  });
});
