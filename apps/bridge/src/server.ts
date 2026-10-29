import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { crossSiteWarning, loadBridgeConfig } from './config.js';
import { migrateBridge } from './db/migrate.js';
import { runOnce } from './deliveries/runner.js';
import { dispatchOnce, HttpEventSender, UNKNOWN_EVENT_GIVE_UP_HOURS } from './events/dispatch.js';
import { seedInternalConnection } from './connections/repo.js';
import { withSchemaRepair } from './db/repair.js';
import { prunePackagesOnce } from './packages/prune.js';
import { buildFromConfig } from './wiring.js';

const config = loadBridgeConfig();
const migrations =
  process.env.BRIDGE_MIGRATIONS_DIR ??
  fileURLToPath(new URL('../../../db/bridge-migrations', import.meta.url));
await migrateBridge(config.DATABASE_URL, migrations);

// A connection per delivery runner, besides the API's and the other loops'.
const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10 + config.BRIDGE_DELIVERY_RUNNERS,
});
const built = await buildFromConfig(config, {
  pool,
  logger: { level: config.LOG_LEVEL },
});
const { app, runner } = built;
const crossSite = crossSiteWarning(config.BRIDGE_APP_ORIGIN, config.BRIDGE_PUBLIC_URL);
if (crossSite) app.log.warn(crossSite);
pool.on('error', (err) => app.log.error({ err }, 'database connection lost'));
await seedInternalConnection(app.deps.connections);
await built.internalStore.ensureBucket(config.BRIDGE_STAGING_BUCKET);

// Every sink is described once before deliveries run (an external one answers within its
// timeout, or is unavailable until a later refresh), then again on an interval.
const refreshSinks = () =>
  built.sinks.refresh().then(() => {
    const down = built.sinks.ids().filter((id) => built.sinks.status(id) === 'unavailable');
    if (down.length) app.log.warn({ sinks: down }, 'sinks unavailable: their describe failed');
  });
await refreshSinks();
setInterval(() => void refreshSinks(), config.BRIDGE_SINK_REFRESH_SECONDS * 1000).unref();
// A sink that is unavailable (started after the bridge, or blinked) is tried again sooner.
setInterval(() => void built.sinks.refreshUnavailable(), 15_000).unref();

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

/**
 * A restore swapped in a database without this schema: migrate and seed again, once for every
 * runner that finds it missing at the same time.
 */
let repairing: Promise<void> | null = null;
const repair = () =>
  (repairing ??= (async () => {
    app.log.warn('the bridge schema is missing (a restore?): migrating again');
    await migrateBridge(config.DATABASE_URL, migrations);
    await seedInternalConnection(app.deps.connections);
  })().finally(() => {
    repairing = null;
  }));

// Several runners, so one slow sink never holds up the rest; the claim keeps each tenant
// (a sink's instance) within its lanes however many run.
const loops = Array.from({ length: config.BRIDGE_DELIVERY_RUNNERS }, (_, n) =>
  loop(
    `delivery runner ${n + 1}`,
    withSchemaRepair(async () => (await runOnce(runner, new Date())) === 'worked', repair),
    1000,
  ),
);
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
      async () =>
        (await dispatchOnce(
          {
            deliveries: runner.deliveries,
            sender,
            onDropped: (e) =>
              app.log.warn(
                { deliveryId: e.deliveryId, eventId: e.eventId, sequence: e.sequence },
                `event ${e.eventId} dropped: the producer has not known delivery ${e.deliveryId} for ${UNKNOWN_EVENT_GIVE_UP_HOURS} hours`,
              ),
          },
          new Date(),
        )) > 0,
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
