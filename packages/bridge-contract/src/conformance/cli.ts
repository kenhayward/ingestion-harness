import { conformanceSuite } from './suite.js';

/** Runs the conformance suite against SINK_URL; exits non-zero when any check fails. */
const env = process.env;
const missing = ['SINK_URL', 'SINK_KEY', 'SINK_INSTANCE'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing environment variables: ${missing.join(', ')}`);
  process.exit(2);
}
const results = await conformanceSuite({
  url: env.SINK_URL!,
  key: env.SINK_KEY!,
  instanceId: env.SINK_INSTANCE!,
  credential: env.SINK_CREDENTIAL
    ? (JSON.parse(env.SINK_CREDENTIAL) as Record<string, string>)
    : null,
  destination: env.SINK_DESTINATION
    ? (JSON.parse(env.SINK_DESTINATION) as Record<string, string>)
    : {},
});
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
