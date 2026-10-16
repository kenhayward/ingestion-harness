import { describe, expect, it } from 'vitest';
import {
  GitHubLinkBodySchema,
  PushOutcomeSchema,
  RecipeFileSchema,
  SyncNameSchema,
  SyncRootSchema,
  definitionCanonical,
  instanceFilePath,
  parseRecipePath,
  recipeFilePath,
} from '../src/github-sync.js';

const sampleFile = {
  format: 'ct-recipe',
  formatVersion: 1,
  instance: 'production',
  version: {
    number: 3,
    status: 'published',
    label: 'Handles 2-page invoices',
    note: null,
    labelSetBy: 'Ken',
    labelSetAt: '2026-10-16T10:00:00.000Z',
    publishedBy: 'Ken',
    publishedAt: '2026-10-16T10:00:00.000Z',
    basedOn: 2,
    importedFrom: null,
    definitionSha256: 'a'.repeat(64),
  },
  definition: { name: 'Invoice' },
};

describe('recipe paths', () => {
  it.each([
    ['ct-studio', 'production', 'invoice', 3, 'ct-studio/production/invoice/v3.yaml'],
    ['data/ct', 'ken-dev', 'po', 12, 'data/ct/ken-dev/po/v12.yaml'],
  ])('recipeFilePath(%s,%s,%s,%d)', (root, inst, id, v, path) => {
    expect(recipeFilePath(root, inst, id, v)).toBe(path);
    expect(parseRecipePath(root, path)).toEqual({
      instance: inst,
      typeId: id,
      version: v,
      draft: false,
    });
  });
  it('builds the instance file path', () => {
    expect(instanceFilePath('data/ct', 'production')).toBe('data/ct/production/instance.yaml');
  });
  it('reads a reserved draft file as draft and other files as null', () => {
    expect(parseRecipePath('ct-studio', 'ct-studio/production/invoice/v4.draft.yaml')?.draft).toBe(
      true,
    );
    expect(parseRecipePath('ct-studio', 'ct-studio/production/instance.yaml')).toBeNull();
    expect(parseRecipePath('ct-studio', 'ct-studio/production/invoice/notes.md')).toBeNull();
    expect(parseRecipePath('ct-studio', 'other/production/invoice/v1.yaml')).toBeNull();
  });
});

describe('definitionCanonical', () => {
  it('ignores id, version and key order', () => {
    expect(definitionCanonical({ id: 'a', version: 1, name: 'X', outputs: { b: 1, a: 2 } })).toBe(
      definitionCanonical({ outputs: { a: 2, b: 1 }, name: 'X', id: 'b', version: 9 }),
    );
  });
});

describe('schemas', () => {
  it('accepts the sample file', () => {
    expect(RecipeFileSchema.safeParse(sampleFile).success).toBe(true);
  });
  it('RecipeFileSchema refuses unknown keys and other format versions', () => {
    expect(RecipeFileSchema.safeParse({ ...sampleFile, extra: 1 }).success).toBe(false);
    expect(RecipeFileSchema.safeParse({ ...sampleFile, formatVersion: 2 }).success).toBe(false);
  });
  it.each(['Production', 'a b', '-x', ''])('refuses instance name %j', (n) =>
    expect(SyncNameSchema.safeParse(n).success).toBe(false),
  );
  it.each(['ct-studio', 'data/ct'])('accepts root %j', (r) =>
    expect(SyncRootSchema.safeParse(r).success).toBe(true),
  );
  it.each(['/ct', 'ct/', 'a//b', 'A/b', ''])('refuses root %j', (r) =>
    expect(SyncRootSchema.safeParse(r).success).toBe(false),
  );
  it('link body validates repo and root', () => {
    const ok = {
      repo: 'acme/recipes',
      branch: 'main',
      root: 'ct-studio',
      alwaysPr: false,
      pushOnPublish: true,
    };
    expect(GitHubLinkBodySchema.safeParse(ok).success).toBe(true);
    expect(GitHubLinkBodySchema.safeParse({ ...ok, repo: 'nope' }).success).toBe(false);
    expect(GitHubLinkBodySchema.safeParse({ ...ok, root: '/x' }).success).toBe(false);
  });
  it('push outcome is discriminated on kind', () => {
    expect(
      PushOutcomeSchema.safeParse({ kind: 'pr', prNumber: 4, prUrl: 'https://x/4' }).success,
    ).toBe(true);
    expect(PushOutcomeSchema.safeParse({ kind: 'failed' }).success).toBe(false);
  });
});
