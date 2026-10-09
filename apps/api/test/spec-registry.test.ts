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

  it('loads document templates (template.yaml) alongside legacy specs', () => {
    const root = mkdtempSync(join(tmpdir(), 'specs-'));
    const dir = join(root, 'demo', 'v3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'template.yaml'),
      [
        'id: demo',
        'version: 3',
        'name: Demo document',
        'document: { sections: [{ id: h, anchor: "^H" }] }',
        'outputs: { fields: [{ id: product, type: text }] }',
        'pipeline: [{ type: extract, id: s, fields: [product], sections: [h] }]',
      ].join('\n'),
    );
    const registry = SpecRegistry.loadFromDir(root);
    expect(registry.list()).toEqual([
      { id: 'demo', version: 3, title: 'Demo document', description: undefined, kind: 'template' },
    ]);
    expect(registry.get('demo')?.version).toBe(3);
  });

  it('fails when a template step names a missing custom prompt', () => {
    const root = mkdtempSync(join(tmpdir(), 'specs-'));
    const dir = join(root, 'demo', 'v1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'template.yaml'),
      [
        'id: demo',
        'version: 1',
        'name: Demo',
        'document: { sections: [{ id: h, anchor: "^H" }] }',
        'outputs: { fields: [{ id: product }] }',
        'pipeline: [{ type: extract, id: s, fields: [product], sections: [h], prompt: p.j2 }]',
      ].join('\n'),
    );
    expect(() => SpecRegistry.loadFromDir(root)).toThrow(/prompt not found/);
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
