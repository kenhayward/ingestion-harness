/**
 * Seeds Workbench projects for trying the project list at scale:
 *   DATABASE_URL=postgres://… npm run seed:workbench -w @ih/api -- 1000 [prefix]
 * Writes rows straight into that database (ids `<prefix>-0001` …, prefix default `seed`); point
 * it at a dev or throwaway database, never production. Nothing goes to the object store.
 * Like `npm run dev:api`, it needs `@ih/shared` built (`npm run build -w @ih/shared`).
 */
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required (the database to write the seeded projects to)');
  process.exit(1);
}
const [countArg = '1000', prefix = 'seed'] = process.argv.slice(2);
const count = Number(countArg);
if (!Number.isInteger(count) || count < 1 || count > 9999) {
  console.error(`count must be a whole number from 1 to 9999, got ${countArg}`);
  process.exit(1);
}
if (!/^[a-z][a-z0-9_]*$/.test(prefix)) {
  console.error(`prefix must match ^[a-z][a-z0-9_]*$, got ${prefix}`);
  process.exit(1);
}

console.warn(
  `WARNING: writing ${count} Workbench projects (${prefix}-0001 …) with their templates, ` +
    `documents and jobs to ${new URL(url).host}`,
);
// Loaded after the checks above, so a refusal never needs the build.
const { seedWorkbenchProjects } = await import('../src/workbench/seed.js');
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const ids = await seedWorkbenchProjects(pool, count, prefix);
  console.log(`seeded ${ids.length} projects`);
} catch (err) {
  console.error(`seeding failed, nothing was written: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
