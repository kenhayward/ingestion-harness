import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateTemplate } from './definitions.js';
import type { TemplateRepo } from './repo.js';

/**
 * Import specs/<id>/v<N>/template.yaml files that are not in the database yet, as published.
 * Idempotent: existing versions are never touched (the database is the source of truth).
 * Returns "id vN" for each version imported.
 */
export async function seedTemplates(repo: TemplateRepo, specsDir: string): Promise<string[]> {
  const imported: string[] = [];
  if (!existsSync(specsDir)) return imported;
  for (const idDir of readdirSync(specsDir, { withFileTypes: true })) {
    if (!idDir.isDirectory()) continue;
    for (const verDir of readdirSync(join(specsDir, idDir.name), { withFileTypes: true })) {
      const file = join(specsDir, idDir.name, verDir.name, 'template.yaml');
      if (!verDir.isDirectory() || !existsSync(file)) continue;
      const definition = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const id = String(definition.id);
      const version = Number(definition.version);
      if (await repo.get(id, version)) continue;
      const issues = validateTemplate(definition);
      if (issues.length) {
        throw new Error(`cannot seed ${file}: ${issues.map((i) => i.message).join('; ')}`);
      }
      await repo.create(id, version, definition, 'published');
      imported.push(`${id} v${version}`);
    }
  }
  return imported;
}
