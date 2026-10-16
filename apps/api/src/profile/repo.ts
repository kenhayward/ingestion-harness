/** How long a GitHub link may take, from Connect to the callback. */
export const LINK_STATE_MS = 10 * 60_000;

/** The details a user edits themselves (the name lives on `users`, edited through AccessRepo). */
export interface ProfileDetails {
  jobTitle: string | null;
  company: string | null;
  /** The name in `linkedin.com/in/<name>`. */
  linkedin: string | null;
}

export interface NewGitHubLink {
  /** GitHub's numeric user id: a login can be renamed, the id cannot. */
  id: number;
  login: string;
  avatarUrl: string;
  /** The OAuth token, encrypted (`encryptSecret`). */
  tokenEnc: string;
}

export interface StoredGitHub extends NewGitHubLink {
  linkedAt: string;
  /** `owner/name` of the repository recipe YAML will be stored in. */
  repo: string | null;
}

export interface StoredProfile extends ProfileDetails {
  github: StoredGitHub | null;
}

/**
 * Users' own profiles (migration 0044, docs/design/profile.md): `PgProfileRepo` /
 * `MemoryProfileRepo`, held in step by `test/profile-contract.ts`.
 */
export interface ProfileRepo {
  /** An empty profile for a user who never saved one. */
  get(userId: string): Promise<StoredProfile>;
  update(userId: string, details: ProfileDetails): Promise<StoredProfile>;
  /**
   * Links (or relinks) a GitHub account; 'taken' when another user has it. Relinking the same
   * account keeps the chosen repository; another account clears it.
   */
  linkGitHub(userId: string, link: NewGitHubLink): Promise<StoredProfile | 'taken'>;
  /** Forgets the account; returns the token it held (to revoke), null when none was linked. */
  unlinkGitHub(userId: string): Promise<string | null>;
  setGitHubRepo(userId: string, repo: string | null): Promise<StoredProfile | 'not_linked'>;
  /** Records a GitHub link in progress by its state's hash, pruning expired ones. */
  startLink(userId: string, stateHash: string): Promise<void>;
  /** The user who started this link, once, while under LINK_STATE_MS old; else null. */
  takeLink(stateHash: string): Promise<string | null>;
}

const EMPTY: StoredProfile = { jobTitle: null, company: null, linkedin: null, github: null };

export class MemoryProfileRepo implements ProfileRepo {
  private readonly profiles = new Map<string, StoredProfile>();
  private readonly links = new Map<string, { userId: string; at: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(userId: string): Promise<StoredProfile> {
    return structuredClone(this.profiles.get(userId) ?? EMPTY);
  }

  async update(userId: string, details: ProfileDetails): Promise<StoredProfile> {
    this.profiles.set(userId, { ...(await this.get(userId)), ...details });
    return this.get(userId);
  }

  async linkGitHub(userId: string, link: NewGitHubLink): Promise<StoredProfile | 'taken'> {
    for (const [other, profile] of this.profiles) {
      if (other !== userId && profile.github?.id === link.id) return 'taken';
    }
    const profile = await this.get(userId);
    const repo = profile.github?.id === link.id ? profile.github.repo : null;
    const linkedAt = new Date(this.now()).toISOString();
    this.profiles.set(userId, { ...profile, github: { ...link, linkedAt, repo } });
    return this.get(userId);
  }

  async unlinkGitHub(userId: string): Promise<string | null> {
    const profile = await this.get(userId);
    if (!profile.github) return null;
    this.profiles.set(userId, { ...profile, github: null });
    return profile.github.tokenEnc;
  }

  async setGitHubRepo(userId: string, repo: string | null): Promise<StoredProfile | 'not_linked'> {
    const profile = await this.get(userId);
    if (!profile.github) return 'not_linked';
    this.profiles.set(userId, { ...profile, github: { ...profile.github, repo } });
    return this.get(userId);
  }

  async startLink(userId: string, stateHash: string): Promise<void> {
    for (const [hash, link] of this.links) {
      if (this.now() - link.at > LINK_STATE_MS) this.links.delete(hash);
    }
    this.links.set(stateHash, { userId, at: this.now() });
  }

  async takeLink(stateHash: string): Promise<string | null> {
    const link = this.links.get(stateHash);
    this.links.delete(stateHash);
    return link && this.now() - link.at <= LINK_STATE_MS ? link.userId : null;
  }
}
