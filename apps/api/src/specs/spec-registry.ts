import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DocumentSpecSchema,
  SpecSummarySchema,
  TemplateSchema,
  type DocumentSpec,
  type Template,
} from '@ih/shared';
import { z } from 'zod';

/** A loaded document type definition: legacy spec.yaml or document template (template.yaml). */
export type Definition =
  | { kind: 'spec'; id: string; version: number; spec: DocumentSpec }
  | { kind: 'template'; id: string; version: number; template: Template };

export const DefinitionSummarySchema = SpecSummarySchema.extend({
  kind: z.enum(['spec', 'template']).describe('`spec`: a legacy spec.yaml; `template`: a template.'),
});
export type DefinitionSummary = z.infer<typeof DefinitionSummarySchema>;

const issuesOf = (error: { issues: { path: (string | number)[]; message: string }[] }) =>
  error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

export class SpecRegistry {
  private constructor(private readonly defs: Map<string, Definition[]>) {}

  /** Build from already-parsed legacy specs (tests). */
  static fromSpecs(list: DocumentSpec[]): SpecRegistry {
    return SpecRegistry.fromDefinitions(
      list.map((spec) => ({ kind: 'spec', id: spec.id, version: spec.version, spec })),
    );
  }

  static fromDefinitions(list: Definition[]): SpecRegistry {
    const byId = new Map<string, Definition[]>();
    for (const def of list) byId.set(def.id, [...(byId.get(def.id) ?? []), def]);
    for (const versions of byId.values()) versions.sort((a, b) => a.version - b.version);
    return new SpecRegistry(byId);
  }

  /**
   * Load every specs/<id>/v<N>/{spec,template}.yaml. Fails loudly on any invalid file, a
   * directory name that disagrees with the file's id/version, or a missing prompt file.
   */
  static loadFromDir(root: string): SpecRegistry {
    const errors: string[] = [];
    const loaded: Definition[] = [];

    for (const idDir of readdirSync(root, { withFileTypes: true })) {
      if (!idDir.isDirectory()) continue;
      for (const verDir of readdirSync(join(root, idDir.name), { withFileTypes: true })) {
        if (!verDir.isDirectory() || !/^v\d+$/.test(verDir.name)) continue;
        const dir = join(root, idDir.name, verDir.name);
        const specFile = join(dir, 'spec.yaml');
        const templateFile = join(dir, 'template.yaml');
        const prompts: [string, string][] = [];
        let def: Definition;

        if (existsSync(templateFile)) {
          const result = TemplateSchema.safeParse(parseYaml(readFileSync(templateFile, 'utf8')));
          if (!result.success) {
            errors.push(`${templateFile}: ${issuesOf(result.error)}`);
            continue;
          }
          const t = result.data;
          def = { kind: 'template', id: t.id, version: t.version, template: t };
          for (const step of t.pipeline) {
            if (step.type === 'extract' && step.prompt)
              prompts.push([`step "${step.id}"`, step.prompt]);
          }
        } else if (existsSync(specFile)) {
          const result = DocumentSpecSchema.safeParse(parseYaml(readFileSync(specFile, 'utf8')));
          if (!result.success) {
            errors.push(`${specFile}: ${issuesOf(result.error)}`);
            continue;
          }
          const s = result.data;
          def = { kind: 'spec', id: s.id, version: s.version, spec: s };
          for (const ex of s.extractions) prompts.push([`extraction "${ex.id}"`, ex.prompt]);
        } else {
          errors.push(`${dir}: missing spec.yaml or template.yaml`);
          continue;
        }

        if (def.id !== idDir.name || `v${def.version}` !== verDir.name) {
          errors.push(`${dir}: id/version (${def.id} v${def.version}) does not match directory`);
        }
        for (const [owner, prompt] of prompts) {
          if (!prompt.startsWith('builtin/') && !existsSync(join(dir, prompt))) {
            errors.push(`${dir}: ${owner} prompt not found: ${prompt}`);
          }
        }
        loaded.push(def);
      }
    }

    if (errors.length) throw new Error(`Invalid document specs:\n  ${errors.join('\n  ')}`);
    return SpecRegistry.fromDefinitions(loaded);
  }

  /** Latest version when `version` is omitted. */
  get(id: string, version?: number): Definition | undefined {
    const versions = this.defs.get(id);
    if (!versions) return undefined;
    return version === undefined ? versions.at(-1) : versions.find((d) => d.version === version);
  }

  list(): DefinitionSummary[] {
    return [...this.defs.values()]
      .flat()
      .map((d) =>
        d.kind === 'spec'
          ? {
              id: d.id,
              version: d.version,
              title: d.spec.title,
              description: d.spec.description,
              kind: d.kind,
            }
          : {
              id: d.id,
              version: d.version,
              title: d.template.name,
              description: d.template.description,
              kind: d.kind,
            },
      )
      .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
  }
}
