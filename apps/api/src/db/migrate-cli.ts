import { fileURLToPath } from 'node:url';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const dir =
  process.env.MIGRATIONS_DIR ??
  fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

const applied = await migrate(url, dir);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
