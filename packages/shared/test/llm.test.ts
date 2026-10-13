import { describe, expect, it } from 'vitest';
import { modelRefProblem, resolveAlias } from '../src/index.js';

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
    ['local/llama-3', 'model local/llama-3 is not offered: add it on the Models page'],
    ['openai/gpt-oss-20b', 'model openai/gpt-oss-20b is not offered: add it on the Models page'],
    [
      'fast',
      'model choice fast uses anthropic/claude-haiku-5-5, which is not offered: add it on the Models page',
    ],
    ['loop', 'model choice loop does not resolve to a model'],
    ['nope', 'unknown model choice nope'],
  ])('%s', (ref, problem) => {
    expect(modelRefProblem(ref, offered, aliases)).toBe(problem);
  });

  it('can leave unknown alias names to the worker (template checks)', () => {
    expect(modelRefProblem('default', offered, {}, { unknownAliases: 'allow' })).toBeNull();
    expect(modelRefProblem('local/x', offered, {}, { unknownAliases: 'allow' })).toBe(
      'model local/x is not offered: add it on the Models page',
    );
  });
});
