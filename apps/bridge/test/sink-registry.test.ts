import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeError, type SinkDescribe } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { FakeDocumentSink } from '../src/sinks/fake-documents.js';
import { FakeSink } from '../src/sinks/fake.js';
import { SinkError } from '../src/sinks/port.js';
import { CachingSinkRegistry, parseSinkEntries } from '../src/sinks/registry.js';

const KEY32 = 's'.repeat(32);
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'fake',
  url: 'http://fake-sink:8080',
  key: KEY32,
  ...over,
});
const json = (v: unknown) => JSON.stringify(v);

/** The error parseSinkEntries throws for `env`. */
const problem = (env: Record<string, string>) => {
  try {
    parseSinkEntries(env);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('parseSinkEntries', () => {
  it('reads BRIDGE_SINKS, or the file BRIDGE_SINKS_FILE names; unset is none', () => {
    expect(parseSinkEntries({})).toEqual([]);
    expect(parseSinkEntries({ BRIDGE_SINKS: '' })).toEqual([]);
    expect(parseSinkEntries({ BRIDGE_SINKS: json([entry()]) })).toEqual([entry()]);
    const file = join(mkdtempSync(join(tmpdir(), 'sinks-')), 'sinks.json');
    writeFileSync(file, json([entry({ id: 'other' })]));
    expect(parseSinkEntries({ BRIDGE_SINKS_FILE: file })).toEqual([entry({ id: 'other' })]);
  });

  it('refuses a bad entry, naming it and never printing a key', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ BRIDGE_SINKS: json([entry()]), BRIDGE_SINKS_FILE: '/x' }, /not both/],
      [{ BRIDGE_SINKS: json([entry(), entry()]) }, /sink fake: the id is used twice/],
      [{ BRIDGE_SINKS: json([entry({ id: 's3' })]) }, /sink s3: s3 and rdf are built in/],
      [{ BRIDGE_SINKS: json([entry({ url: 'ftp://x' })]) }, /sink fake: url/],
      [{ BRIDGE_SINKS: json([entry({ url: 'http://u:p@x' })]) }, /sink fake: url/],
      [{ BRIDGE_SINKS: json([entry({ key: 'short-key' })]) }, /sink fake: key/],
      [{ BRIDGE_SINKS: json([entry({ id: 'Bad Id' })]) }, /id/],
      [{ BRIDGE_SINKS: '{not json' }, /BRIDGE_SINKS is not JSON/],
    ];
    for (const [env, message] of cases) {
      const text = problem(env);
      expect(text).toMatch(message);
      expect(text).not.toContain(KEY32);
      expect(text).not.toContain('short-key');
    }
  });
});

/** A sink whose describe fails while `down` is set. */
class Flaky extends FakeSink {
  down = false;
  calls = 0;
  override async describe(): Promise<SinkDescribe> {
    this.calls += 1;
    if (this.down) throw new SinkError(bridgeError('sink_unavailable', 'down'));
    return super.describe();
  }
}

describe('CachingSinkRegistry', () => {
  it('describes each sink once per refresh, and answers from the cache', async () => {
    const sink = new Flaky({ name: 'Remote' });
    const registry = new CachingSinkRegistry({ fake: sink });
    await registry.refresh();
    expect(sink.calls).toBe(1);
    expect((await registry.get('fake')!.describe()).name).toBe('Remote');
    expect((await registry.get('fake')!.describe()).name).toBe('Remote');
    expect(sink.calls).toBe(1);
    expect(registry.status('fake')).toBe('available');
    expect(registry.ids()).toEqual(['fake']);
    expect(registry.get('nope')).toBeNull();
  });

  it("keeps an external sink's watched folders as it declared them, and its folder calls", async () => {
    const docs = new FakeDocumentSink();
    const registry = new CachingSinkRegistry({ docs });
    await registry.refresh();
    const port = registry.get('docs')!;
    const described = await port.describe();
    expect(described.capabilities.watchedFolders).toEqual(
      (await docs.describe()).capabilities.watchedFolders,
    );
    expect(described.capabilities.readBack).toBe(false);
    expect(port.sources).toBe(docs.sources);
  });

  it('a failed refresh keeps the last good describe and marks the sink unavailable', async () => {
    const sink = new Flaky({ name: 'Remote' });
    const registry = new CachingSinkRegistry({ fake: sink });
    await registry.refresh();
    sink.down = true;
    await registry.refresh();
    expect(registry.status('fake')).toBe('unavailable');
    expect((await registry.get('fake')!.describe()).name).toBe('Remote');
    sink.down = false;
    await registry.refresh();
    expect(registry.status('fake')).toBe('available');
  });

  it('a sink never described is unavailable and has no describe', async () => {
    const sink = new Flaky();
    sink.down = true;
    const registry = new CachingSinkRegistry({ fake: sink });
    expect(registry.status('fake')).toBe('unavailable');
    await registry.refresh();
    await expect(registry.get('fake')!.describe()).rejects.toMatchObject({
      error: { code: 'sink_unavailable' },
    });
  });

  it('hands out the last describe without a call, none before the first', async () => {
    const sink = new Flaky({ name: 'Remote' });
    const registry = new CachingSinkRegistry({ fake: sink });
    expect(registry.described('fake')).toBeNull();
    await registry.refresh();
    expect(registry.described('fake')?.name).toBe('Remote');
    sink.down = true;
    await registry.refresh();
    expect(registry.described('fake')?.name).toBe('Remote');
  });

  it('passes every other call straight to the sink', async () => {
    const sink = new FakeSink();
    const registry = new CachingSinkRegistry({ fake: sink });
    await registry.refresh();
    await registry.get('fake')!.testConnection({ instanceId: 'a', credential: {} });
    expect(sink.tested).toHaveLength(1);
  });
});

describe('CachingSinkRegistry, unavailable sinks', () => {
  it('refreshUnavailable describes only the sinks that are unavailable', async () => {
    const up = new Flaky({ name: 'Up' });
    const late = new Flaky({ name: 'Late' });
    late.down = true;
    const registry = new CachingSinkRegistry({ up, late });
    await registry.refresh();
    expect(registry.status('late')).toBe('unavailable');
    late.down = false;
    await registry.refreshUnavailable();
    expect(registry.status('late')).toBe('available');
    expect(up.calls).toBe(1);
    expect(late.calls).toBe(2);
  });
});
