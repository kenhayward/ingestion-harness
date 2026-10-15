import { describe, expect, it } from 'vitest';
import {
  GITHUB_LINK_RESULTS,
  GitHubRepoBodySchema,
  ProfileBodySchema,
  ProfileSchema,
  githubRepoProblem,
  linkedinName,
} from '../src/index.js';

describe('linkedinName', () => {
  it.each([
    ['ken-hayward', 'ken-hayward'],
    ['  Ken-Hayward  ', 'Ken-Hayward'],
    ['https://www.linkedin.com/in/ken-hayward/', 'ken-hayward'],
    ['linkedin.com/in/ken-hayward', 'ken-hayward'],
    ['http://uk.linkedin.com/in/ken-hayward?trk=x', 'ken-hayward'],
    ['@ken-hayward', 'ken-hayward'],
    ['', null],
    ['ab', null],
    ['ken hayward', null],
    ['https://example.com/in/ken', null],
    ['https://www.linkedin.com/company/acme', null],
    ['x'.repeat(101), null],
  ])('%j -> %j', (input, name) => {
    expect(linkedinName(input)).toBe(name);
  });
});

describe('githubRepoProblem', () => {
  it.each([
    ['ken/ct-recipes', null],
    ['ken-h/recipes.yaml_store', null],
    ['ken', 'name the repository as owner/name'],
    ['ken/', 'name the repository as owner/name'],
    ['/recipes', 'name the repository as owner/name'],
    ['ken/re pos', 'name the repository as owner/name'],
    ['ken/a/b', 'name the repository as owner/name'],
    ['-ken/repo', 'name the repository as owner/name'],
  ])('%j -> %j', (repo, problem) => {
    expect(githubRepoProblem(repo)).toBe(problem);
  });
});

describe('profile schemas', () => {
  it('reads blank optional details as null and refuses a bad LinkedIn name', () => {
    expect(
      ProfileBodySchema.parse({ name: ' Ken ', jobTitle: ' ', company: 'Acme', linkedin: '' }),
    ).toEqual({ name: 'Ken', jobTitle: null, company: 'Acme', linkedin: null });
    expect(
      ProfileBodySchema.parse({
        name: 'Ken',
        jobTitle: null,
        company: null,
        linkedin: 'https://www.linkedin.com/in/ken-hayward/',
      }).linkedin,
    ).toBe('ken-hayward');
    expect(
      ProfileBodySchema.safeParse({ name: 'Ken', jobTitle: null, company: null, linkedin: 'a b' })
        .success,
    ).toBe(false);
    expect(ProfileBodySchema.safeParse({ name: ' ' }).success).toBe(false);
  });

  it('takes a repository or null', () => {
    expect(GitHubRepoBodySchema.parse({ repo: 'ken/recipes' })).toEqual({ repo: 'ken/recipes' });
    expect(GitHubRepoBodySchema.parse({ repo: null })).toEqual({ repo: null });
    expect(GitHubRepoBodySchema.safeParse({ repo: 'ken' }).success).toBe(false);
  });

  it('describes a profile with or without GitHub', () => {
    const profile = {
      name: 'Ken',
      email: 'ken@example.com',
      jobTitle: null,
      company: null,
      linkedin: null,
      github: null,
      githubAvailable: false,
    };
    expect(ProfileSchema.parse(profile)).toEqual(profile);
    const linked = {
      ...profile,
      github: {
        login: 'kenhayward',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
        linkedAt: '2026-10-15T09:00:00.000Z',
        repo: null,
      },
    };
    expect(ProfileSchema.parse(linked)).toEqual(linked);
  });

  it('names every result the GitHub link can return to the app with', () => {
    expect(GITHUB_LINK_RESULTS).toEqual(['linked', 'denied', 'expired', 'taken', 'failed']);
  });
});
