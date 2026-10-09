import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SpecRegistry } from '../src/specs/spec-registry.js';

const repoSpecsDir = fileURLToPath(new URL('../../../specs', import.meta.url));

describe('SpecRegistry', () => {
  it('loads every spec committed under /specs (contract test — keep green)', () => {
    const registry = SpecRegistry.loadFromDir(repoSpecsDir);
    expect(registry.get('process-validation-protocol')?.version).toBeGreaterThanOrEqual(1);
  });

  it('fails when the directory name disagrees with the spec id/version', () => {
    const root = mkdtempSync(join(tmpdir(), 'specs-'));
    const dir = join(root, 'wrong-name', 'v1');
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', 'p.md.j2'), 'x');
    writeFileSync(
      join(dir, 'spec.yaml'),
      [
        'id: demo',
        'version: 1',
        'title: Demo',
        'document: { sections: [{ id: h, anchor: "^H" }] }',
        'extractions: [{ id: e, sections: [h], prompt: prompts/p.md.j2, schema: { type: object } }]',
        'outputs: [{ id: o, format: json, from: "*" }]',
      ].join('\n'),
    );
    expect(() => SpecRegistry.loadFromDir(root)).toThrow(/does not match directory/);
  });

  it('fails when a prompt template is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'specs-'));
    const dir = join(root, 'demo', 'v1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'spec.yaml'),
      [
        'id: demo',
        'version: 1',
        'title: Demo',
        'document: { sections: [{ id: h, anchor: "^H" }] }',
        'extractions: [{ id: e, sections: [h], prompt: prompts/missing.md.j2, schema: { type: object } }]',
        'outputs: [{ id: o, format: json, from: "*" }]',
      ].join('\n'),
    );
    expect(() => SpecRegistry.loadFromDir(root)).toThrow(/prompt not found/);
  });
});
