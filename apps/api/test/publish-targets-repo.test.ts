import { describe, expect, it } from 'vitest';
import {
  MemoryPublishTargetRepo,
  primaryTargetOf,
  type PublishedDefinition,
} from '../src/publish-targets/repo.js';
import { publishTargetsContract } from './publish-targets-contract.js';

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
    },
  };
});

describe('primaryTargetOf', () => {
  const t = (id: string, layout: 'files' | 'package') => ({ id, layout });
  it('picks the first files-layout target in list order', () => {
    const targets = [t('archive', 'package'), t('lake', 'files'), t('default', 'files')];
    expect(primaryTargetOf(['archive', 'lake', 'default'], targets)).toBe('lake');
    expect(primaryTargetOf(['default', 'lake'], targets)).toBe('default');
  });
  it('is undefined when every listed target is an archive or unknown', () => {
    expect(primaryTargetOf(['archive', 'nope'], [t('archive', 'package')])).toBeUndefined();
  });
});
