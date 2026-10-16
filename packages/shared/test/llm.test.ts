import { describe, expect, it } from 'vitest';
import { modelRefProblem, pickedChoice, pickerChoices, resolveAlias } from '../src/index.js';

const offered = new Set(['local/qwen', 'ryzen/openai/gpt-oss-20b']);
const aliases = {
  default: 'local/qwen',
  cheap: 'default',
  fast: 'anthropic/claude-haiku-5-5',
  loop: 'loop',
};

describe('resolveAlias', () => {
  it.each([
    ['cheap', 'local/qwen'],
    ['default', 'local/qwen'],
    ['local/qwen', 'local/qwen'],
    ['loop', null],
    ['nope', null],
  ])('%s → %s', (name, ref) => {
    expect(resolveAlias(name, aliases)).toBe(ref);
  });
});

describe('modelRefProblem (only configured models run)', () => {
  it.each([
    ['local/qwen', null],
    ['ryzen/openai/gpt-oss-20b', null],
    ['cheap', null],
    ['local/llama-3', 'model local/llama-3 is not offered: add it under Administration > Models'],
    [
      'openai/gpt-oss-20b',
      'model openai/gpt-oss-20b is not offered: add it under Administration > Models',
    ],
    [
      'fast',
      'model choice fast uses anthropic/claude-haiku-5-5, which is not offered: add it under Administration > Models',
    ],
    ['loop', 'model choice loop does not resolve to a model'],
    ['nope', 'unknown model choice nope'],
  ])('%s', (ref, problem) => {
    expect(modelRefProblem(ref, offered, aliases)).toBe(problem);
  });

  it('can leave unknown alias names to the worker (template checks)', () => {
    expect(modelRefProblem('default', offered, {}, { unknownAliases: 'allow' })).toBeNull();
    expect(modelRefProblem('local/x', offered, {}, { unknownAliases: 'allow' })).toBe(
      'model local/x is not offered: add it under Administration > Models',
    );
  });
});

describe('pickerChoices (what people pick, by label)', () => {
  const choice = (id: string, label: string, ref: string) => ({
    id,
    label,
    description: '',
    ref,
    source: 'env' as const,
    editedAt: null,
    updatedBy: null,
  });
  const endpoints = [
    { name: 'local', location: 'local' as const },
    { name: 'ryzen', location: 'external' as const },
  ];

  it('lists offered choices with their location, the default first, then by label', () => {
    const picks = pickerChoices(
      [
        choice('zeta', 'Zeta', 'local/qwen'),
        choice('test', 'New for testing only', 'ryzen/openai/gpt-oss-20b'),
        choice('main', 'Main Production Model', 'local/qwen'),
        choice('gone', 'Gone', 'local/withdrawn'),
        choice('nowhere', 'Nowhere', 'cloud/x'),
      ],
      { defaultChoice: 'zeta' },
      endpoints,
      new Set(['local/qwen', 'ryzen/openai/gpt-oss-20b', 'cloud/x']),
    );
    expect(picks.map((c) => [c.id, c.location, c.isDefault])).toEqual([
      ['zeta', 'local', true],
      ['main', 'local', false],
      ['test', 'external', false],
      // An endpoint nobody declared is external (the worker's rule too).
      ['nowhere', 'external', false],
    ]);
  });

  it('finds the choice a pick names, `default` included', () => {
    const picks = pickerChoices(
      [choice('main', 'Main', 'local/qwen')],
      { defaultChoice: 'main' },
      endpoints,
      new Set(['local/qwen']),
    );
    expect(pickedChoice('default', picks)?.id).toBe('main');
    expect(pickedChoice('main', picks)?.label).toBe('Main');
    expect(pickedChoice('local/qwen', picks)).toBeNull();
    expect(pickedChoice('nope', picks)).toBeNull();
  });
});
