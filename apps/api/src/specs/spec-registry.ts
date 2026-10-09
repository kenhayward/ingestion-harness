import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DocumentSpecSchema, type DocumentSpec, type SpecSummary } from '@ih/shared';

export class SpecRegistry {
  private constructor(private readonly specs: Map<string, DocumentSpec[]>) {}

  /** Build from already-parsed specs (tests). Versions are sorted ascending. */
  static fromSpecs(list: DocumentSpec[]): SpecRegistry {
    const byId = new Map<string, DocumentSpec[]>();
    for (const spec of list) {
      byId.set(spec.id, [...(byId.get(spec.id) ?? []), spec]);
    }
    for (const versions of byId.values()) versions.sort((a, b) => a.version - b.version);
    return new SpecRegistry(byId);
  }

  /**
   * Load every specs/<id>/v<N>/spec.yaml. Fails loudly on any invalid spec, a directory
   * name that disagrees with the file's id/version, or a missing prompt template.
   */
  static loadFromDir(root: string): SpecRegistry {
    const errors: string[] = [];
    const loaded: DocumentSpec[] = [];

    for (const idDir of readdirSync(root, { withFileTypes: true })) {
      if (!idDir.isDirectory()) continue;
      for (const verDir of readdirSync(join(root, idDir.name), { withFileTypes: true })) {
        if (!verDir.isDirectory() || !/^v\d+$/.test(verDir.name)) continue;
        const dir = join(root, idDir.name, verDir.name);
        const file = join(dir, 'spec.yaml');
        if (!existsSync(file)) {
          errors.push(`${dir}: missing spec.yaml`);
          continue;
        }
        const result = DocumentSpecSchema.safeParse(parseYaml(readFileSync(file, 'utf8')));
        if (!result.success) {
          errors.push(
            `${file}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          );
          continue;
        }
        const spec = result.data;
        if (spec.id !== idDir.name || `v${spec.version}` !== verDir.name) {
          errors.push(`${file}: id/version (${spec.id} v${spec.version}) does not match directory`);
        }
        for (const ex of spec.extractions) {
          if (!existsSync(join(dir, ex.prompt))) {
            errors.push(`${file}: extraction "${ex.id}" prompt not found: ${ex.prompt}`);
          }
        }
        loaded.push(spec);
      }
    }

    if (errors.length) throw new Error(`Invalid document specs:\n  ${errors.join('\n  ')}`);
    return SpecRegistry.fromSpecs(loaded);
  }

  /** Latest version when `version` is omitted. */
  get(id: string, version?: number): DocumentSpec | undefined {
    const versions = this.specs.get(id);
    if (!versions) return undefined;
    return version === undefined ? versions.at(-1) : versions.find((s) => s.version === version);
  }

  list(): SpecSummary[] {
    return [...this.specs.values()]
      .flat()
      .map(({ id, version, title, description }) => ({ id, version, title, description }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
  }
}
