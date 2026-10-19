import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadBridgeConfig } from './config.js';
import { migrateBridge } from './db/migrate.js';
import { runOnce } from './deliveries/runner.js';
import { dispatchOnce, HttpEventSender } from './events/dispatch.js';
import { seedInternalConnection } from './connections/repo.js';
import { withSchemaRepair } from './db/repair.js';
import { prunePackagesOnce } from './packages/prune.js';
import { buildFromConfig } from './wiring.js';

const config = loadBridgeConfig();
const migrations =
  process.env.BRIDGE_MIGRATIONS_DIR ??
  fileURLToPath(new URL('../../../db/bridge-migrations', import.meta.url));
await migrateBridge(config.DATABASE_URL, migrations);

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
const built = await buildFromConfig(config, {
  pool,
  logger: { level: config.LOG_LEVEL },
});
const { app, runner } = built;
pool.on('error', (err) => app.log.error({ err }, 'database connection lost'));
await seedInternalConnection(app.deps.connections);
await built.internalStore.ensureBucket(config.BRIDGE_STAGING_BUCKET);

let stopping = false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `tick` until the process stops, pausing `idleMs` whenever it reports no work. */
async function loop(name: string, tick: () => Promise<boolean>, idleMs: number): Promise<void> {
  while (!stopping) {
    try {
      if (!(await tick())) await sleep(idleMs);
    } catch (err) {
      app.log.error({ err }, `${name} failed`);
      await sleep(idleMs);
    }
  }
}

/** A restore swapped in a database without this schema: migrate and seed again. */
const repair = async () => {
  app.log.warn('the bridge schema is missing (a restore?): migrating again');
  await migrateBridge(config.DATABASE_URL, migrations);
  await seedInternalConnection(app.deps.connections);
};

const loops = [
  loop(
    'delivery runner',
    withSchemaRepair(async () => (await runOnce(runner, new Date())) === 'worked', repair),
    1000,
  ),
];
loops.push(
  loop(
    'package pruner',
    async () =>
      (await prunePackagesOnce(
        { deliveries: runner.deliveries, packages: runner.packages },
        new Date(),
      )) > 0,
    10 * 60_000,
  ),
);
if (config.BRIDGE_EVENTS_URL) {
  const sender = new HttpEventSender(config.BRIDGE_EVENTS_URL, config.BRIDGE_CLIENT_KEY);
  loops.push(
    loop(
      'event dispatcher',
      async () => (await dispatchOnce({ deliveries: runner.deliveries, sender }, new Date())) > 0,
      2000,
    ),
  );
}

process.once('SIGTERM', () => {
  stopping = true;
  void Promise.all(loops)
    .then(() => app.close())
    .then(() => pool.end())
    .then(() => process.exit(0));
});

await app.listen({ host: config.HOST, port: config.PORT });
