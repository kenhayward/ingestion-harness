import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  packageVersionFor,
  SinkDescribeSchema,
  SourceListRequestSchema,
  SourceMoveRequestSchema,
  SourcePutRequestSchema,
  SOURCE_FOLDERS,
  SOURCE_PATHS,
  sourceNameProblem,
  watchedFoldersOf,
} from '../src/index.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('contract version 4: watched folders', () => {
  it('a version 4 describe declares watched folders', () => {
    const d = SinkDescribeSchema.parse(fixture('describe-v4.json'));
    expect(d.contractVersion).toBe(4);
    expect(watchedFoldersOf(d)?.sourceFields).toHaveLength(1);
  });

  it('watched folders need contractVersion 4', () => {
    const v4 = fixture('describe-v4.json') as object;
    const r = SinkDescribeSchema.safeParse({ ...v4, contractVersion: 3 });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('watchedFolders needs contractVersion 4');
  });

  it('watchedFoldersOf is null for older versions and sinks without it', () => {
    expect(watchedFoldersOf(SinkDescribeSchema.parse(fixture('describe-v3.json')))).toBeNull();
    const v4 = fixture('describe-v4.json') as { capabilities: Record<string, unknown> };
    const rest = { ...v4.capabilities };
    delete rest.watchedFolders;
    const bare = SinkDescribeSchema.parse({ ...v4, capabilities: rest });
    expect(watchedFoldersOf(bare)).toBeNull();
  });

  it('packages never go above version 2', () => {
    expect(packageVersionFor(4)).toBe(2);
  });

  it('names the four folders', () => {
    expect([...SOURCE_FOLDERS]).toEqual(['', 'processing', 'delivered', 'failed']);
    expect(SOURCE_PATHS.list).toBe('/sources::list');
  });

  it('refuses names that are not one path segment', () => {
    for (const bad of [
      '',
      '.',
      '..',
      'a/b.pdf',
      String.raw`a\b.pdf`,
      'x\u0000.pdf',
      'a'.repeat(256),
    ]) {
      expect(sourceNameProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(sourceNameProblem('Report 1.docx')).toBeNull();
    expect(sourceNameProblem('a'.repeat(255))).toBeNull();
  });

  it.each([
    ['source-list.json', SourceListRequestSchema],
    ['source-move.json', SourceMoveRequestSchema],
    ['source-put.json', SourcePutRequestSchema],
  ] as const)('%s parses and re-serialises unchanged', (name, schema) => {
    const raw = fixture(name);
    expect(schema.parse(raw)).toStrictEqual(raw);
  });

  it('put takes at most 65,536 characters and a known folder', () => {
    const put = fixture('source-put.json') as object;
    expect(SourcePutRequestSchema.safeParse({ ...put, content: 'x'.repeat(65537) }).success).toBe(
      false,
    );
    expect(SourcePutRequestSchema.safeParse({ ...put, folder: 'elsewhere' }).success).toBe(false);
  });
});
