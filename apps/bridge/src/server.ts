import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadBridgeConfig } from './config.js';
import { migrateBridge } from './db/migrate.js';
import { runOnce } from './deliveries/runner.js';
import { dispatchOnce, HttpEventSender } from './events/dispatch.js';
import { buildFromConfig } from './wiring.js';

const config = loadBridgeConfig();
const migrations =
  process.env.BRIDGE_MIGRATIONS_DIR ??
  fileURLToPath(new URL('../../../db/bridge-migrations', import.meta.url));
await migrateBridge(config.DATABASE_URL, migrations);

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
const { app, runner } = await buildFromConfig(config, {
  pool,
  logger: { level: config.LOG_LEVEL },
});
pool.on('error', (err) => app.log.error({ err }, 'database connection lost'));

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

const loops = [
  loop('delivery runner', async () => (await runOnce(runner, new Date())) === 'worked', 1000),
];
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
