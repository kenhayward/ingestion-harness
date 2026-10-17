import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrationNameProblems } from '../src/db/migration-names.js';

describe('migrationNameProblems', () => {
  it('accepts the numbered migrations up to 0049 and timestamped ones after', () => {
    expect(
      migrationNameProblems(['0001_init.sql', '0049_x.sql', '202610171030_add_thing.sql']),
    ).toEqual([]);
  });

  it('refuses a new numbered migration', () => {
    const problems = migrationNameProblems(['0050_new.sql']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('0050_new.sql');
    expect(problems[0]).toContain('name new migrations YYYYMMDDHHMM_description.sql');
  });

  it.each([
    ['a description that is not snake_case', '202610171030_Add-Thing.sql'],
    ['eleven digits', '20261017103_x.sql'],
    ['month 13', '202613171030_x.sql'],
    ['minute 60', '202610172460_x.sql'],
    ['30 February', '202602301030_x.sql'],
  ])('refuses %s', (_name, file) => {
    const problems = migrationNameProblems([file]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(file);
  });

  it('refuses two migrations with one timestamp, naming both', () => {
    const problems = migrationNameProblems(['202610171030_a.sql', '202610171030_b.sql']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('202610171030_a.sql');
    expect(problems[0]).toContain('202610171030_b.sql');
  });

  it('ignores files that are not migrations', () => {
    expect(migrationNameProblems(['README.md'])).toEqual([]);
  });

  it('finds nothing wrong in db/migrations', () => {
    const dir = fileURLToPath(new URL('../../../db/migrations', import.meta.url));
    expect(migrationNameProblems(readdirSync(dir))).toEqual([]);
  });
});
