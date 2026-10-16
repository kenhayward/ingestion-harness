import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SYNC_ROOT,
  type GitHubLinkBody,
  type GitHubLinkView,
  type SyncSettingsBody,
  type SyncSettingsView,
} from '@ih/shared';

export interface SyncSettings {
  instanceName: string;
  instanceId: string;
  defaultRoot: string;
  firstPushedAt: string | null;
}

export interface VersionPush {
  typeId: string;
  version: number;
  repo: string;
  branch: string;
  path: string;
  commit: string;
  blobSha: string;
  labelSha: string;
  prNumber: number | null;
  prUrl: string | null;
  prState: 'open' | 'merged' | 'closed' | null;
  pushedBy: string;
  pushedAt: string;
}

/** The default instance name: `CT_INSTANCE_NAME` if it is a valid name, else `default`. */
export function defaultInstanceName(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.CT_INSTANCE_NAME?.trim().toLowerCase();
  return v && /^[a-z0-9][a-z0-9-]{0,62}$/.test(v) ? v : 'default';
}

/**
 * Settings, links and push records of the GitHub recipe sync (migration 0048): `PgGitHubSyncRepo` /
 * `MemoryGitHubSyncRepo`, held in step by `test/github-sync-contract.ts`.
 */
export interface GitHubSyncRepo {
  /** This deployment's identity; the row is created on first read. */
  settings(): Promise<SyncSettings>;
  /** 'locked' when the name changes after anything was pushed; the root may always change. */
  setSettings(body: SyncSettingsBody, by: string): Promise<'locked' | SyncSettingsView>;
  link(typeId: string): Promise<GitHubLinkView | null>;
  setLink(typeId: string, body: GitHubLinkBody, by: string): Promise<GitHubLinkView>;
  removeLink(typeId: string): Promise<boolean>;
  /** The type is gone (its last version was deleted): its link and push records go too. */
  forgetType(typeId: string): Promise<void>;
  pushes(typeId: string): Promise<VersionPush[]>;
  /** Upserts by type and version: the newest push wins. */
  recordPush(push: VersionPush): Promise<void>;
  /** Sets `firstPushedAt` once. */
  markPushed(): Promise<void>;
}

export class MemoryGitHubSyncRepo implements GitHubSyncRepo {
  private row: SyncSettings | null = null;
  private readonly links = new Map<string, GitHubLinkView>();
  private readonly records = new Map<string, VersionPush>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async settings(): Promise<SyncSettings> {
    this.row ??= {
      instanceName: defaultInstanceName(),
      instanceId: randomUUID(),
      defaultRoot: DEFAULT_SYNC_ROOT,
      firstPushedAt: null,
    };
    return { ...this.row };
  }

  async setSettings(body: SyncSettingsBody, _by: string): Promise<'locked' | SyncSettingsView> {
    const cur = await this.settings();
    if (body.instanceName !== cur.instanceName && cur.firstPushedAt !== null) return 'locked';
    this.row = { ...cur, instanceName: body.instanceName, defaultRoot: body.defaultRoot };
    return {
      instanceName: this.row.instanceName,
      instanceId: this.row.instanceId,
      defaultRoot: this.row.defaultRoot,
      locked: this.row.firstPushedAt !== null,
    };
  }

  async link(typeId: string) {
    const l = this.links.get(typeId);
    return l ? { ...l } : null;
  }

  async setLink(typeId: string, body: GitHubLinkBody, by: string) {
    const view: GitHubLinkView = { ...body, setBy: by, setAt: this.now().toISOString() };
    this.links.set(typeId, view);
    return { ...view };
  }

  async removeLink(typeId: string) {
    return this.links.delete(typeId);
  }

  async forgetType(typeId: string): Promise<void> {
    this.links.delete(typeId);
    for (const [key, p] of this.records) if (p.typeId === typeId) this.records.delete(key);
  }

  async pushes(typeId: string) {
    return [...this.records.values()]
      .filter((p) => p.typeId === typeId)
      .sort((a, b) => a.version - b.version)
      .map((p) => ({ ...p }));
  }

  async recordPush(push: VersionPush) {
    this.records.set(`${push.typeId}\u0000${push.version}`, { ...push });
  }

  async markPushed() {
    const cur = await this.settings();
    this.row = { ...cur, firstPushedAt: cur.firstPushedAt ?? this.now().toISOString() };
  }
}
