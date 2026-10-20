import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DraftLog, DraftLogEntry } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { draftAttempts } from '../src/workbench/draft-log.js';

const fixture = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../packages/shared/test/fixtures/draft-log.json',
    ),
    'utf8',
  ),
) as { singleReplies: DraftLog; toolRun: DraftLog };

const log = (entries: DraftLogEntry[], label = 'draft-outputs'): DraftLog => ({
  stage: 'outputs',
  model: 'local/qwen',
  tools: false,
  legacy: false,
  rounds: [{ label, entries }],
});

const summary = (l: DraftLog) =>
  draftAttempts(l).map((r) => ({
    name: r.name,
    attempts: r.attempts.map((a) => [a.n, a.status, a.errors.length, a.entries.length]),
  }));

describe('draftAttempts: a drafting log as rounds of attempts', () => {
  it('splits after each rejected answer; the retry note opens the next attempt', () => {
    expect(summary(fixture.singleReplies)).toEqual([
      {
        name: 'Proposal',
        attempts: [
          [1, 'refused', 4, 3],
          [2, 'accepted', 0, 2],
        ],
      },
    ]);
  });

  it('keeps tool calls with the attempt they belong to', () => {
    const [round] = draftAttempts(fixture.toolRun);
    expect(round!.attempts.map((a) => [a.n, a.status])).toEqual([
      [1, 'refused'],
      [2, 'accepted'],
    ]);
    expect(round!.attempts[0]!.entries.map((e) => e.kind)).toContain('toolResult');
  });

  it('names the anchor round and later rounds', () => {
    const l = log([{ kind: 'prompt', text: 'p', images: 0 }]);
    l.rounds = [
      { label: 'draft-sections', entries: [{ kind: 'prompt', text: 'p', images: 0 }] },
      { label: 'draft-sections-anchors', entries: [{ kind: 'prompt', text: 'p', images: 0 }] },
      { label: 'draft-x', entries: [{ kind: 'prompt', text: 'p', images: 0 }] },
    ];
    expect(draftAttempts(l).map((r) => r.name)).toEqual(['Proposal', 'Anchor round', 'Round 3']);
  });

  it.each<[string, DraftLogEntry[], string, string | null]>([
    [
      'an error stops it',
      [
        { kind: 'prompt', text: 'p', images: 0 },
        { kind: 'error', message: 'drafting model refused: no' },
      ],
      'stopped',
      'drafting model refused: no',
    ],
    ['a prompt with no answer yet', [{ kind: 'prompt', text: 'p', images: 0 }], 'unanswered', null],
    [
      'a reply with nothing after it',
      [
        { kind: 'prompt', text: 'p', images: 0 },
        { kind: 'reply', text: '{}', inputTokens: 5, outputTokens: 7 },
      ],
      'accepted',
      null,
    ],
  ])('%s', (_, entries, status, error) => {
    const [attempt] = draftAttempts(log(entries))[0]!.attempts;
    expect(attempt!.status).toBe(status);
    expect(attempt!.error).toBe(error);
  });

  it('adds up an attempt’s output tokens, and leaves out an empty round', () => {
    const l = log([
      { kind: 'prompt', text: 'p', images: 0 },
      { kind: 'reply', text: '', inputTokens: 1, outputTokens: 40 },
      { kind: 'reply', text: '{}', inputTokens: 1, outputTokens: 120 },
    ]);
    l.rounds.push({ label: 'draft-outputs-2', entries: [] });
    const rounds = draftAttempts(l);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.attempts[0]!.outputTokens).toBe(160);
  });
});
