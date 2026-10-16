import { MemoryPublishTargetRepo, type PublishedDefinition } from '../src/publish-targets/repo.js';
import { publishTargetsContract } from './publish-targets-contract.js';

publishTargetsContract('memory', async () => {
  const published: PublishedDefinition[] = [];
  const delivered = new Map<string, number>();
  const consumers = new Map<string, number>();
  const bump = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);
  const repo = new MemoryPublishTargetRepo({
    publishedDefinitions: async () => published,
    deliveredCount: async (id) => delivered.get(id) ?? 0,
    consumerCount: async (id) => consumers.get(id) ?? 0,
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
    },
  };
});
