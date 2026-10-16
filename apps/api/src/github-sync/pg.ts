import type {
  GitHubLinkBody,
  GitHubLinkView,
  SyncSettingsBody,
  SyncSettingsView,
} from '@ih/shared';
import type pg from 'pg';
import {
  defaultInstanceName,
  type GitHubSyncRepo,
  type SyncSettings,
  type VersionPush,
} from './repo.js';

interface SettingsRow {
  instance_name: string;
  instance_id: string;
  default_root: string;
  first_pushed_at: Date | null;
}
interface LinkRow {
  repo: string;
  branch: string;
  root: string;
  always_pr: boolean;
  push_on_publish: boolean;
  set_by: string | null;
  set_at: Date;
}
interface PushRow {
  type_id: string;
  version: number;
  repo: string;
  branch: string;
  path: string;
  commit_sha: string;
  blob_sha: string;
  label_sha: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: VersionPush['prState'];
  pushed_by: string;
  pushed_at: Date;
}

const settingsOf = (r: SettingsRow): SyncSettings => ({
  instanceName: r.instance_name,
  instanceId: r.instance_id,
  defaultRoot: r.default_root,
  firstPushedAt: r.first_pushed_at ? r.first_pushed_at.toISOString() : null,
});

const linkOf = (r: LinkRow): GitHubLinkView => ({
  repo: r.repo,
  branch: r.branch,
  root: r.root,
  alwaysPr: r.always_pr,
  pushOnPublish: r.push_on_publish,
  setBy: r.set_by,
  setAt: r.set_at.toISOString(),
});

const pushOf = (r: PushRow): VersionPush => ({
  typeId: r.type_id,
  version: r.version,
  repo: r.repo,
  branch: r.branch,
  path: r.path,
  commit: r.commit_sha,
  blobSha: r.blob_sha,
  labelSha: r.label_sha,
  prNumber: r.pr_number,
  prUrl: r.pr_url,
  prState: r.pr_state,
  pushedBy: r.pushed_by,
  pushedAt: r.pushed_at.toISOString(),
});

/** GitHub sync settings, links and push records in Postgres (migration 0046). */
export class PgGitHubSyncRepo implements GitHubSyncRepo {
  constructor(private readonly pool: pg.Pool) {}

  async settings(): Promise<SyncSettings> {
    await this.pool.query(
      `INSERT INTO github_sync_settings (instance_name) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [defaultInstanceName()],
    );
    const { rows } = await this.pool.query<SettingsRow>(
      `SELECT instance_name, instance_id, default_root, first_pushed_at FROM github_sync_settings`,
    );
    return settingsOf(rows[0]!);
  }

  async setSettings(body: SyncSettingsBody, by: string): Promise<'locked' | SyncSettingsView> {
    await this.settings();
    const { rows } = await this.pool.query<SettingsRow>(
      `UPDATE github_sync_settings
          SET instance_name = $1, default_root = $2, set_by = $3, set_at = now()
        WHERE first_pushed_at IS NULL OR instance_name = $1
        RETURNING instance_name, instance_id, default_root, first_pushed_at`,
      [body.instanceName, body.defaultRoot, by],
    );
    if (!rows[0]) return 'locked';
    const s = settingsOf(rows[0]);
    return {
      instanceName: s.instanceName,
      instanceId: s.instanceId,
      defaultRoot: s.defaultRoot,
      locked: s.firstPushedAt !== null,
    };
  }

  async link(typeId: string) {
    const { rows } = await this.pool.query<LinkRow>(
      `SELECT repo, branch, root, always_pr, push_on_publish, set_by, set_at
         FROM template_github_links WHERE type_id = $1`,
      [typeId],
    );
    return rows[0] ? linkOf(rows[0]) : null;
  }

  async setLink(typeId: string, b: GitHubLinkBody, by: string) {
    const { rows } = await this.pool.query<LinkRow>(
      `INSERT INTO template_github_links
         (type_id, repo, branch, root, always_pr, push_on_publish, set_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (type_id) DO UPDATE
         SET repo = $2, branch = $3, root = $4, always_pr = $5, push_on_publish = $6,
             set_by = $7, set_at = now()
       RETURNING repo, branch, root, always_pr, push_on_publish, set_by, set_at`,
      [typeId, b.repo, b.branch, b.root, b.alwaysPr, b.pushOnPublish, by],
    );
    return linkOf(rows[0]!);
  }

  async removeLink(typeId: string) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM template_github_links WHERE type_id = $1',
      [typeId],
    );
    return (rowCount ?? 0) > 0;
  }

  async forgetType(typeId: string) {
    await this.pool.query(
      `WITH pushes AS (DELETE FROM template_github_pushes WHERE type_id = $1)
       DELETE FROM template_github_links WHERE type_id = $1`,
      [typeId],
    );
  }

  async pushes(typeId: string) {
    const { rows } = await this.pool.query<PushRow>(
      `SELECT * FROM template_github_pushes WHERE type_id = $1 ORDER BY version`,
      [typeId],
    );
    return rows.map(pushOf);
  }

  async recordPush(p: VersionPush) {
    await this.pool.query(
      `INSERT INTO template_github_pushes
         (type_id, version, repo, branch, path, commit_sha, blob_sha, label_sha,
          pr_number, pr_url, pr_state, pushed_by, pushed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (type_id, version) DO UPDATE
         SET repo = $3, branch = $4, path = $5, commit_sha = $6, blob_sha = $7, label_sha = $8,
             pr_number = $9, pr_url = $10, pr_state = $11, pushed_by = $12, pushed_at = $13`,
      [
        p.typeId,
        p.version,
        p.repo,
        p.branch,
        p.path,
        p.commit,
        p.blobSha,
        p.labelSha,
        p.prNumber,
        p.prUrl,
        p.prState,
        p.pushedBy,
        p.pushedAt,
      ],
    );
  }

  async markPushed() {
    await this.settings();
    await this.pool.query(
      `UPDATE github_sync_settings SET first_pushed_at = now() WHERE first_pushed_at IS NULL`,
    );
  }
}
