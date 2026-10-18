import { signatureOf, type RememberedAnswer } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import type { MappingMemoryRepo, VoteInput } from '../src/mapping-memory/repo.js';

const LIT: RememberedAnswer = { form: 'literal', property: 'https://x.example/batch' };
const ENT: RememberedAnswer = {
  form: 'entity',
  property: 'https://x.example/has',
  class: 'https://x.example/Batch',
  iri: 'batch/{value|slug}',
};

export function vote(
  path: string,
  answer: RememberedAnswer,
  over: Partial<VoteInput> = {},
): VoteInput {
  const name = over.name ?? 'Batch number';
  const sig = signatureOf({ kind: 'column', name, type: 'text', table: 'Batches' });
  return {
    path,
    kind: 'column',
    signatureKey: sig.key,
    name,
    description: '',
    type: 'text',
    unit: sig.unit,
    table: 'Batches',
    answer,
    ontologies: ['afo'],
    version: 1,
    external: false,
    ...over,
  };
}

/** The MappingMemoryRepo contract, run on MemoryMappingMemoryRepo and PgMappingMemoryRepo. */
export function mappingMemoryContract(name: string, make: () => Promise<MappingMemoryRepo>) {
  describe(`${name}: mapping memory contract`, () => {
    it('keeps one entry per signature and answer, one vote per recipe and output', async () => {
      const repo = await make();
      await repo.replaceVotes('a', [vote('t.batch', LIT), vote('u.batch', LIT)], 'ken');
      await repo.replaceVotes('b', [vote('t.batch', LIT)], 'ken');
      const { entries, total } = await repo.list({});
      expect(total).toBe(1);
      expect(entries[0]).toMatchObject({ votes: 2, refusals: 0, status: 'learned', answer: LIT });
      expect(entries[0]!.recipes).toEqual([
        { id: 'a', path: 't.batch', version: 1 },
        { id: 'a', path: 'u.batch', version: 1 },
        { id: 'b', path: 't.batch', version: 1 },
      ]);
      expect(await repo.votedTemplates()).toEqual(['a', 'b']);
    });

    it('moves a recipe vote and forgets an entry nobody uses or reviewed', async () => {
      const repo = await make();
      await repo.replaceVotes('a', [vote('t.batch', LIT)], null);
      await repo.replaceVotes('a', [vote('t.batch', ENT)], null);
      const { entries } = await repo.list({});
      expect(entries.map((e) => e.answer)).toEqual([ENT]);
      await repo.replaceVotes('a', [], null);
      expect((await repo.list({})).total).toBe(0);
      expect(await repo.votedTemplates()).toEqual([]);
    });

    it('keeps a reviewed entry without votes', async () => {
      const repo = await make();
      await repo.replaceVotes('a', [vote('t.batch', LIT)], null);
      const [entry] = (await repo.list({})).entries;
      await repo.patch(entry!.id, { status: 'confirmed' }, 'Ada');
      await repo.replaceVotes('a', [], null);
      expect(await repo.get(entry!.id)).toMatchObject({
        status: 'confirmed',
        votes: 0,
        reviewedBy: 'Ada',
      });
    });

    it('records a refusal when a pre-selected answer is replaced or removed', async () => {
      const repo = await make();
      await repo.replaceVotes('other', [vote('t.batch', LIT)], null);
      await repo.replaceVotes('a', [vote('t.batch', LIT), vote('u.batch', LIT)], null);
      const [entry] = (await repo.list({})).entries;
      await repo.setOrigins('a', { 't.batch': entry!.id, 'u.batch': entry!.id });
      // Saving again with the same answers keeps the origins: no refusal.
      expect(
        await repo.replaceVotes('a', [vote('t.batch', LIT), vote('u.batch', LIT)], null),
      ).toEqual({ refused: 0 });
      // One output relinked, the other unmapped: two refusals, the recipe counted once.
      expect(await repo.replaceVotes('a', [vote('t.batch', ENT)], 'ken')).toEqual({ refused: 2 });
      expect(await repo.get(entry!.id)).toMatchObject({ votes: 1, refusals: 1 });
    });

    it('adds a refusal once, and none for an unknown entry', async () => {
      const repo = await make();
      await repo.replaceVotes('a', [vote('t.batch', LIT)], null);
      const [entry] = (await repo.list({})).entries;
      await repo.addRefusal(entry!.id, 'x', 'p', 'ken');
      await repo.addRefusal(entry!.id, 'x', 'p', 'ken');
      await repo.addRefusal('00000000-0000-0000-0000-000000000000', 'x', 'p', 'ken');
      expect(await repo.get(entry!.id)).toMatchObject({ refusals: 1 });
    });

    it('filters by status, ontology, wording and term, and pages', async () => {
      const repo = await make();
      await repo.replaceVotes(
        'a',
        [
          vote('t.batch', LIT),
          vote(
            't.expiry',
            { form: 'literal', property: 'https://x.example/exp' },
            {
              name: 'Expiry date',
              ontologies: ['obi'],
            },
          ),
        ],
        null,
      );
      const expiry = (await repo.list({ q: 'expiry' })).entries;
      expect(expiry.map((e) => e.name)).toEqual(['Expiry date']);
      expect((await repo.list({ ontology: 'afo' })).entries.map((e) => e.name)).toEqual([
        'Batch number',
      ]);
      expect((await repo.list({ term: 'https://x.example/exp' })).total).toBe(1);
      await repo.patch(expiry[0]!.id, { status: 'rejected' }, 'Ada');
      expect((await repo.list({ status: 'review' })).entries.map((e) => e.name)).toEqual([
        'Batch number',
      ]);
      expect((await repo.list({ status: 'rejected' })).total).toBe(1);
      const page = await repo.list({ pageSize: 1, page: 2 });
      expect(page.total).toBe(2);
      expect(page.entries).toHaveLength(1);
    });

    it('adds by hand, confirms an existing answer, refuses a clashing edit and deletes', async () => {
      const repo = await make();
      await repo.replaceVotes('a', [vote('t.batch', LIT)], null);
      const sig = signatureOf({ kind: 'column', name: 'Batch number', type: 'text' });
      const input = {
        kind: 'column' as const,
        signatureKey: sig.key,
        name: 'Batch number',
        description: '',
        type: 'text',
        unit: '',
        ontologies: ['afo'],
        note: 'checked',
        external: false,
      };
      const confirmed = await repo.create({ ...input, answer: LIT }, 'Ada');
      expect(confirmed).toMatchObject({
        status: 'confirmed',
        votes: 1,
        note: 'checked',
        reviewedBy: 'Ada',
      });
      const other = await repo.create({ ...input, answer: ENT }, 'Ada');
      expect((await repo.list({})).total).toBe(2);
      expect(await repo.patch(other.id, { answer: LIT }, 'Ada')).toBe('conflict');
      expect(
        await repo.patch('00000000-0000-0000-0000-000000000000', { status: 'rejected' }, 'Ada'),
      ).toBeNull();
      expect(await repo.delete(other.id)).toBe(true);
      expect(await repo.delete(other.id)).toBe(false);
      expect((await repo.list({})).total).toBe(1);
    });
  });
}
