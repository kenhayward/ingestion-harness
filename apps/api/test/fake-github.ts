import type { GitHubRepo } from '@ih/shared';
import { GitHubError, type GitHubOAuth, type GitHubUser } from '../src/profile/github.js';

/**
 * GitHub for route tests: `code` → token → user, as the test sets them up. A code it was not
 * told about is refused like GitHub refuses an old one.
 */
export class FakeGitHub implements GitHubOAuth {
  /** code -> token */
  readonly codes = new Map<string, string>();
  /** token -> user */
  readonly users = new Map<string, GitHubUser>();
  /** token -> repositories it can push to */
  readonly repoLists = new Map<string, GitHubRepo[]>();
  readonly revoked: string[] = [];
  readonly exchanges: { code: string; redirectUri: string }[] = [];
  failRevoke = false;

  /** A GitHub account signing in with `code`. */
  account(code: string, user: GitHubUser, repos: GitHubRepo[] = []) {
    const token = `gho_${user.login}_${code}`;
    this.codes.set(code, token);
    this.users.set(token, user);
    this.repoLists.set(token, repos);
    return token;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ state, redirect_uri: redirectUri });
    return `https://github.test/authorize?${q.toString()}`;
  }

  async exchange(code: string, redirectUri: string): Promise<string> {
    this.exchanges.push({ code, redirectUri });
    const token = this.codes.get(code);
    if (!token) throw new GitHubError('GitHub refused the sign-in: bad_verification_code');
    return token;
  }

  async user(token: string): Promise<GitHubUser> {
    const user = this.users.get(token);
    if (!user) throw new GitHubError('GitHub no longer accepts this link: link the account again');
    return user;
  }

  async repos(token: string): Promise<GitHubRepo[]> {
    const repos = this.repoLists.get(token);
    if (!repos) throw new GitHubError('GitHub no longer accepts this link: link the account again');
    return repos;
  }

  async revoke(token: string): Promise<void> {
    if (this.failRevoke) throw new GitHubError('GitHub answered HTTP 500');
    this.revoked.push(token);
  }
}
