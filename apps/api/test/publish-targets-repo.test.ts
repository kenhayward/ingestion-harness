import { describe, expect, it } from 'vitest';
import {
  MemoryPublishTargetRepo,
  primaryTargetOf,
  type PublishedDefinition,
} from '../src/publish-targets/repo.js';
import { kindOf, s3PlaceOf } from '../src/publish-targets/place.js';
import { publishTargetsContract } from './publish-targets-contract.js';
import { rdfView, s3View } from './target-views.js';

publishTargetsContract('memory', async () => {
  const published: PublishedDefinition[] = [];
  const delivered = new Map<string, number>();
  const consumers = new Map<string, number>();
  const withdrawals: { target: string; status: string }[] = [];
  const bump = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);
  const repo = new MemoryPublishTargetRepo({
    publishedDefinitions: async () => published,
    deliveredCount: async (id) => delivered.get(id) ?? 0,
    consumerCount: async (id) => consumers.get(id) ?? 0,
    pendingJobCount: async (id) =>
      withdrawals.filter((w) => w.target === id && w.status !== 'succeeded').length,
  });
  return {
    repo,
    facts: {
      publish: async (id, version, publishTo) => {
        published.push({
          id,
          version,
          definition: publishTo === null ? {} : { delivery: { publishTo } },
        });
      },
      delivered: async (id) => void bump(delivered, id),
      grant: async (id) => void bump(consumers, id),
      withdrawal: async (target, status) => void withdrawals.push({ target, status }),
      inert: async (id) => repo.makeInert(id),
      legacyKeys: async (keys) => repo.putLegacyKeys(keys),
    },
  };
});

describe('primaryTargetOf', () => {
  const t = (id: string, layout: 'files' | 'package') => s3View({ id, layout });
  it('picks the first files-layout target in list order', () => {
    const targets = [t('archive', 'package'), t('lake', 'files'), t('default', 'files')];
    expect(primaryTargetOf(['archive', 'lake', 'default'], targets)).toBe('lake');
    expect(primaryTargetOf(['default', 'lake'], targets)).toBe('default');
  });
  it('is undefined when every listed target is an archive, another sink or unknown', () => {
    const rdf = rdfView();
    expect(
      primaryTargetOf(['archive', 'rdf-default', 'nope'], [t('archive', 'package'), rdf]),
    ).toBeUndefined();
  });
});

describe('s3PlaceOf', () => {
  it('reads an S3 target’s bucket, prefix and layout (blank is files)', () => {
    expect(s3PlaceOf(s3View({ id: 'a', bucket: 'b', prefix: 'p/', layout: 'package' }))).toEqual({
      bucket: 'b',
      prefix: 'p/',
      layout: 'package',
    });
    expect(s3PlaceOf({ sinkId: 's3', destination: { bucket: 'b', layout: '' } })).toEqual({
      bucket: 'b',
      prefix: '',
      layout: 'files',
    });
  });
  it('s3PlaceOf is null for a non-S3 sink', () => {
    expect(s3PlaceOf(rdfView())).toBeNull();
    expect(s3PlaceOf({ sinkId: 'archive-sink', destination: { bucket: 'b' } })).toBeNull();
  });
});

describe('kindOf', () => {
  it('rdf for the rdf sink, internal on the built-in connection, external for other S3, sink for the rest', () => {
    expect(kindOf(rdfView())).toBe('rdf');
    expect(kindOf(s3View({ id: 'a', kind: 'internal' }))).toBe('internal');
    expect(kindOf(s3View({ id: 'a', connectionId: 'c' }))).toBe('external');
    expect(kindOf(s3View({ id: 'a', connectionId: null }))).toBe('external');
    expect(kindOf({ sinkId: 'archive-sink', connectionId: 'internal' })).toBe('sink');
  });
});
