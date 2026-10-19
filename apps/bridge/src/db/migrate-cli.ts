import { fileURLToPath } from 'node:url';
import { migrateBridge } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const dir =
  process.env.BRIDGE_MIGRATIONS_DIR ??
  fileURLToPath(new URL('../../../../db/bridge-migrations', import.meta.url));

const applied = await migrateBridge(url, dir);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'bridge schema is up to date');
