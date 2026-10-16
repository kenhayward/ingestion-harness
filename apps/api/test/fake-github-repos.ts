import { createHash } from 'node:crypto';
import type { GitHubRepo } from '@ih/shared';
import {
  GitHubError,
  NotFoundError,
  ProtectedBranchError,
  StaleRefError,
  UnauthorizedError,
  type GitHubRepoApi,
} from '../src/profile/github.js';

export interface FakeCommit {
  sha: string;
  parent: string | null;
  /** Every file at this commit. */
  files: Map<string, string>;
  message: string;
  /** The token that made the commit ('seed' for test setup). */
  token: string;
}

export interface FakePullRequest {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: 'open' | 'merged' | 'closed';
  url: string;
}

type Permission = 'push' | 'read' | 'none';

interface FakeRepo {
  private: boolean;
  branches: Map<string, string>;
  commits: Map<string, FakeCommit>;
  protectedBranches: Set<string>;
  permissions: Map<string, Permission>;
  pulls: FakePullRequest[];
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
/** The blob sha git (and so GitHub) gives some content: sha1 of `blob <bytes>\0<content>`. */
export const fakeBlobSha = (content: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(content, 'utf-8')}\0`)
    .update(content, 'utf-8')
    .digest('hex');

/**
 * GitHub's repository side for tests: an in-memory git model (branches -> head commit -> files),
 * with protected branches, per-token permissions and pull requests. Like GitHub, a repository a
 * token cannot read is not found. Commits are made with `commit` (or `seed` for setup).
 */
export class FakeGitHubRepos implements GitHubRepoApi {
  private readonly repos = new Map<string, FakeRepo>();
  private counter = 0;
  /** Every commit made through `commit`, in order. */
  readonly commits: FakeCommit[] = [];
  /** Observation hook only: `listFiles` always returns the full, correct listing (HttpGitHub's fallback guarantees that); with this on, `treeReads` records 'truncated'. */
  truncateTrees = false;
  /** How GitHub would have been read for each `listFiles`: 'recursive' or 'truncated'. */
  readonly treeReads: ('recursive' | 'truncated')[] = [];
  /** Runs after a commit is built and before the branch moves: move the head here to race it. */
  beforeRefUpdate: (() => void) | null = null;
  /** Tokens GitHub no longer accepts: every call with one is a 401 (`UnauthorizedError`). */
  readonly revoked = new Set<string>();
  /** Every call waits for this first: a GitHub that hangs until the test resolves it. */
  gate: Promise<void> | null = null;
  /** Every call fails as a transport error does through HttpGitHub (no answer from GitHub). */
  unreachable = false;

  addRepo(
    fullName: string,
    access: { token: string; permission: Permission },
    options: { private?: boolean; defaultBranch?: string } = {},
  ) {
    let repo = this.repos.get(fullName);
    if (!repo) {
      repo = {
        private: options.private ?? false,
        branches: new Map(),
        commits: new Map(),
        protectedBranches: new Set(),
        permissions: new Map(),
        pulls: [],
      };
      this.repos.set(fullName, repo);
      const root = this.makeCommit(repo, null, new Map(), 'initial commit', 'seed');
      repo.branches.set(options.defaultBranch ?? 'main', root.sha);
    }
    repo.permissions.set(access.token, access.permission);
  }

  /** Sets what `token` may do in the repository. */
  grant(fullName: string, token: string, permission: Permission) {
    this.repo(fullName).permissions.set(token, permission);
  }

  protect(fullName: string, branch: string, on = true) {
    const set = this.repo(fullName).protectedBranches;
    if (on) set.add(branch);
    else set.delete(branch);
  }

  /** Adds files to a branch as a new commit by 'seed' (not recorded in `commits`); creates the branch from the first one when missing. */
  seed(fullName: string, branch: string, files: Record<string, string>): string {
    const repo = this.repo(fullName);
    const parentSha = repo.branches.get(branch) ?? [...repo.branches.values()][0] ?? null;
    const base = parentSha ? repo.commits.get(parentSha)!.files : new Map<string, string>();
    const next = new Map(base);
    for (const [path, content] of Object.entries(files)) next.set(path, content);
    const commit = this.makeCommit(repo, parentSha, next, 'seed', 'seed');
    repo.branches.set(branch, commit.sha);
    return commit.sha;
  }

  /** The files at a branch's head, by path. */
  files(fullName: string, branch: string): Record<string, string> {
    const repo = this.repo(fullName);
    const sha = repo.branches.get(branch);
    if (!sha) throw new Error(`no branch ${branch}`);
    return Object.fromEntries(repo.commits.get(sha)!.files);
  }

  branches(fullName: string): string[] {
    return [...this.repo(fullName).branches.keys()];
  }

  pulls(fullName: string): FakePullRequest[] {
    return this.repo(fullName).pulls;
  }

  /** Moves a pull request to merged or closed (a merge also fast-forwards its base to the head). */
  setPullRequestState(fullName: string, number: number, state: 'open' | 'merged' | 'closed') {
    const repo = this.repo(fullName);
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) throw new Error(`no pull request ${number}`);
    pull.state = state;
    if (state === 'merged') {
      const head = repo.branches.get(pull.head);
      if (head) repo.branches.set(pull.base, head);
    }
  }

  // --- GitHubRepoApi -------------------------------------------------------------------

  async permission(token: string, repo: string): Promise<Permission> {
    await this.enter();
    if (this.revoked.has(token)) throw new UnauthorizedError();
    return this.repos.get(repo)?.permissions.get(token) ?? 'none';
  }

  async head(token: string, repo: string, branch: string): Promise<string> {
    await this.enter();
    const found = this.readable(token, repo);
    const sha = found.branches.get(branch);
    if (!sha) throw new NotFoundError(`${repo} has no branch ${branch}`);
    return sha;
  }

  async listFiles(token: string, repo: string, commit: string, prefix: string) {
    await this.enter();
    const found = this.readable(token, repo);
    this.treeReads.push(this.truncateTrees ? 'truncated' : 'recursive');
    const dir = prefix.replace(/^\/+|\/+$/g, '');
    return [...this.commitOf(found, commit).files]
      .filter(([path]) => !dir || path.startsWith(`${dir}/`))
      .map(([path, content]) => ({ path, blobSha: fakeBlobSha(content) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(token: string, repo: string, commit: string, path: string) {
    await this.enter();
    const content = this.commitOf(this.readable(token, repo), commit).files.get(path);
    return content === undefined ? null : { content, blobSha: fakeBlobSha(content) };
  }

  async commit(
    token: string,
    input: {
      repo: string;
      branch: string;
      parent: string;
      files: { path: string; content: string }[];
      message: string;
    },
  ): Promise<string> {
    await this.enter();
    const repo = this.readable(token, input.repo);
    if (repo.permissions.get(token) !== 'push') {
      throw new GitHubError('GitHub answered HTTP 403: Resource not accessible');
    }
    const parent = this.commitOf(repo, input.parent);
    const files = new Map(parent.files);
    for (const f of input.files) files.set(f.path, f.content);
    const made = this.makeCommit(repo, parent.sha, files, input.message, token);
    this.beforeRefUpdate?.();
    if (repo.protectedBranches.has(input.branch)) {
      throw new ProtectedBranchError(
        `${input.branch} is protected: GitHub needs a pull request to change it`,
      );
    }
    const current = repo.branches.get(input.branch);
    if (!current) throw new NotFoundError(`${input.repo} has no branch ${input.branch}`);
    if (current !== parent.sha) {
      throw new StaleRefError(`${input.branch} moved on GitHub while pushing`);
    }
    repo.branches.set(input.branch, made.sha);
    this.commits.push(made);
    return made.sha;
  }

  async createBranch(token: string, repo: string, name: string, fromCommit: string) {
    await this.enter();
    const found = this.readable(token, repo);
    this.commitOf(found, fromCommit);
    if (!found.branches.has(name)) found.branches.set(name, fromCommit);
  }

  async openPullRequest(
    token: string,
    input: { repo: string; head: string; base: string; title: string; body: string },
  ) {
    await this.enter();
    const repo = this.readable(token, input.repo);
    const existing = repo.pulls.find((p) => p.head === input.head && p.state === 'open');
    if (existing) return { number: existing.number, url: existing.url };
    if (!repo.branches.has(input.head)) {
      throw new NotFoundError(`${input.repo} has no branch ${input.head}`);
    }
    const number = repo.pulls.length + 1;
    const pull: FakePullRequest = {
      number,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      state: 'open',
      url: `https://github.test/${input.repo}/pull/${number}`,
    };
    repo.pulls.push(pull);
    return { number, url: pull.url };
  }

  async pullRequestState(token: string, repo: string, number: number) {
    await this.enter();
    const pull = this.readable(token, repo).pulls.find((p) => p.number === number);
    if (!pull) throw new NotFoundError(`${repo} has no pull request ${number}`);
    return pull.state;
  }

  async listRepos(token: string): Promise<GitHubRepo[]> {
    await this.enter();
    return [...this.repos.entries()]
      .filter(([, r]) => (r.permissions.get(token) ?? 'none') !== 'none')
      .map(([fullName, r]) => ({ fullName, private: r.private }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' }));
  }

  // --- internals -----------------------------------------------------------------------

  private async enter() {
    if (this.gate) await this.gate;
    if (this.unreachable) throw new GitHubError('GitHub could not be reached: fetch failed');
  }

  private repo(fullName: string): FakeRepo {
    const repo = this.repos.get(fullName);
    if (!repo) throw new Error(`fake repo ${fullName} was not added`);
    return repo;
  }

  private readable(token: string, fullName: string): FakeRepo {
    if (this.revoked.has(token)) throw new UnauthorizedError();
    const repo = this.repos.get(fullName);
    if (!repo || (repo.permissions.get(token) ?? 'none') === 'none') {
      throw new NotFoundError(`${fullName} not found`);
    }
    return repo;
  }

  private commitOf(repo: FakeRepo, sha: string): FakeCommit {
    const commit = repo.commits.get(sha);
    if (!commit) throw new NotFoundError(`commit ${sha} not found`);
    return commit;
  }

  private makeCommit(
    repo: FakeRepo,
    parent: string | null,
    files: Map<string, string>,
    message: string,
    token: string,
  ): FakeCommit {
    const sha = sha1(`commit ${++this.counter} ${parent ?? ''} ${message}`);
    const commit: FakeCommit = { sha, parent, files, message, token };
    repo.commits.set(sha, commit);
    return commit;
  }
}
