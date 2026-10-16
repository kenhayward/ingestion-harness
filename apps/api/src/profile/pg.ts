import type pg from 'pg';
import {
  LINK_STATE_MS,
  type NewGitHubLink,
  type ProfileDetails,
  type ProfileRepo,
  type StoredProfile,
} from './repo.js';

interface Row {
  job_title: string | null;
  company: string | null;
  linkedin: string | null;
  github_id: string | null;
  github_login: string | null;
  github_avatar_url: string | null;
  github_token_enc: string | null;
  github_linked_at: Date | null;
  github_repo: string | null;
}

const COLUMNS = `job_title, company, linkedin, github_id::text, github_login, github_avatar_url,
                 github_token_enc, github_linked_at, github_repo`;

const EMPTY: StoredProfile = { jobTitle: null, company: null, linkedin: null, github: null };

function profileOf(row: Row | undefined): StoredProfile {
  if (!row) return { ...EMPTY };
  return {
    jobTitle: row.job_title,
    company: row.company,
    linkedin: row.linkedin,
    github:
      row.github_id === null
        ? null
        : {
            id: Number(row.github_id),
            login: row.github_login!,
            avatarUrl: row.github_avatar_url!,
            tokenEnc: row.github_token_enc!,
            linkedAt: row.github_linked_at!.toISOString(),
            repo: row.github_repo,
          },
  };
}

/** Users' own profiles in `user_profiles` and `github_link_states` (migration 0044). */
export class PgProfileRepo implements ProfileRepo {
  constructor(private readonly pool: pg.Pool) {}

  async get(userId: string): Promise<StoredProfile> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM user_profiles WHERE user_id = $1`,
      [userId],
    );
    return profileOf(rows[0]);
  }

  async update(userId: string, d: ProfileDetails): Promise<StoredProfile> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO user_profiles (user_id, job_title, company, linkedin) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET job_title = $2, company = $3, linkedin = $4,
                                           updated_at = now()
       RETURNING ${COLUMNS}`,
      [userId, d.jobTitle, d.company, d.linkedin],
    );
    return profileOf(rows[0]);
  }

  async linkGitHub(userId: string, link: NewGitHubLink): Promise<StoredProfile | 'taken'> {
    try {
      const { rows } = await this.pool.query<Row>(
        `INSERT INTO user_profiles AS p (user_id, github_id, github_login, github_avatar_url,
                                        github_token_enc, github_linked_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (user_id) DO UPDATE SET
           github_repo = CASE WHEN p.github_id = $2 THEN p.github_repo END,
           github_id = $2, github_login = $3, github_avatar_url = $4, github_token_enc = $5,
           github_linked_at = now(), updated_at = now()
         RETURNING ${COLUMNS}`,
        [userId, link.id, link.login, link.avatarUrl, link.tokenEnc],
      );
      return profileOf(rows[0]);
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'user_profiles_github_key') {
        return 'taken';
      }
      throw err;
    }
  }

  async unlinkGitHub(userId: string): Promise<string | null> {
    // The old token is read in the same statement that clears it, so it is handed back once.
    const { rows } = await this.pool.query<{ token: string | null }>(
      `UPDATE user_profiles p SET github_id = NULL, github_login = NULL,
              github_avatar_url = NULL, github_token_enc = NULL, github_linked_at = NULL,
              github_repo = NULL, updated_at = now()
       FROM (SELECT user_id, github_token_enc FROM user_profiles
             WHERE user_id = $1 FOR UPDATE) old
       WHERE p.user_id = old.user_id AND old.github_token_enc IS NOT NULL
       RETURNING old.github_token_enc AS token`,
      [userId],
    );
    return rows[0]?.token ?? null;
  }

  async setGitHubRepo(userId: string, repo: string | null): Promise<StoredProfile | 'not_linked'> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE user_profiles SET github_repo = $2, updated_at = now()
       WHERE user_id = $1 AND github_id IS NOT NULL
       RETURNING ${COLUMNS}`,
      [userId, repo],
    );
    return rows[0] ? profileOf(rows[0]) : 'not_linked';
  }

  async startLink(userId: string, stateHash: string): Promise<void> {
    await this.pool.query(
      `WITH pruned AS (
         DELETE FROM github_link_states
         WHERE created_at < now() - make_interval(secs => $3::double precision / 1000))
       INSERT INTO github_link_states (state_hash, user_id) VALUES ($1, $2)`,
      [stateHash, userId, LINK_STATE_MS],
    );
  }

  async takeLink(stateHash: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ user_id: string; fresh: boolean }>(
      `DELETE FROM github_link_states WHERE state_hash = $1
       RETURNING user_id,
                 created_at >= now() - make_interval(secs => $2::double precision / 1000) AS fresh`,
      [stateHash, LINK_STATE_MS],
    );
    return rows[0]?.fresh ? rows[0].user_id : null;
  }
}
