import {
  type BridgePackage,
  type ComponentVersion,
  type DecomposedDocument,
  type Section,
  SinkDescribeSchema,
  type SinkDeliverRequest,
} from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { FakeDocumentSink } from '../src/sinks/fake-documents.js';
import { SinkError } from '../src/sinks/port.js';
import { decomposedPackage, deliverRequest } from './sink-builders.js';

const decomposed = decomposedPackage;

const paragraph = (id: string, text: string) => ({
  kind: 'paragraph' as const,
  id,
  inlines: [{ kind: 'text' as const, text, marks: [] }],
});
const section = (id: string, sections: Section[] = []): Section => ({
  id,
  title: [{ kind: 'text', text: id, marks: [] }],
  blocks: [paragraph(`${id}#p-1`, `text of ${id}`)],
  sections,
});

/** The fixture's package with a different document (and no images unless given). */
function withDocument(
  over: Partial<DecomposedDocument>,
  images: BridgePackage['images'] = [],
): BridgePackage {
  const pkg = structuredClone(decomposed);
  return {
    ...pkg,
    images,
    document: {
      ...pkg.document!,
      blocks: [],
      sections: [],
      images: [],
      equations: [],
      notes: [],
      ...over,
    },
  };
}

const createReq = (pkg: BridgePackage = decomposed, key = 'key-create'): SinkDeliverRequest =>
  deliverRequest({ package: pkg, idempotencyKey: key, destination: { space: 's' } });

const updateReq = (
  persistentId: string,
  expected: ComponentVersion[],
  pkg: BridgePackage = decomposed,
  key = 'key-update',
): SinkDeliverRequest => ({ ...createReq(pkg, key), update: { persistentId, expected } });

async function receiptOf(sink: FakeDocumentSink, req: SinkDeliverRequest) {
  const result = await sink.deliver(req);
  if (result.status !== 'succeeded' || !result.receipt.document) throw new Error('no receipt');
  return result.receipt.document;
}

async function refusal(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof SinkError)) throw new Error(`expected a SinkError, got ${String(err)}`);
  return err.error;
}

const versions = (components: ComponentVersion[]) =>
  Object.fromEntries(components.map((c) => [c.element ?? 'map', c.version]));

describe('FakeDocumentSink, describe', () => {
  it('describes a version 2 sink that takes decomposed documents', async () => {
    const described = await new FakeDocumentSink({ equations: ['latex'] }).describe();
    expect(SinkDescribeSchema.safeParse(described).success).toBe(true);
    expect(described).toMatchObject({
      contractVersion: 2,
      capabilities: {
        accepts: ['document', 'images'],
        readBack: true,
        replace: true,
        decomposedDocuments: { equations: ['latex'] },
      },
    });
    expect((await new FakeDocumentSink().describe()).capabilities.decomposedDocuments).toEqual({
      equations: ['mathml', 'latex', 'image'],
    });
  });
});

describe('FakeDocumentSink, create', () => {
  it('create returns persistent id and component versions', async () => {
    const sink = new FakeDocumentSink();
    const doc = await receiptOf(sink, createReq());
    expect(doc.persistentId).toBe('doc-1');
    expect(doc.readBack).toEqual({ ok: true, at: null, detail: null });
    expect(doc.components.map((c) => [c.kind, c.element, c.version])).toEqual([
      ['map', null, '1'],
      ['section', 's-figures', '1'],
      ...decomposed.images!.map((i) => ['image', i.id, '1']),
    ]);
    expect(new Set(doc.components.map((c) => c.id)).size).toBe(doc.components.length);
    expect(sink.documents.get('doc-1')!.idempotencyKeys).toEqual(new Set(['key-create']));

    const second = await receiptOf(sink, createReq(decomposed, 'key-other'));
    expect(second.persistentId).toBe('doc-2');
  });

  it('lists every section depth first, with the leading blocks as s~lead', async () => {
    const pkg = withDocument({
      blocks: [paragraph('s~lead#p-1', 'before the first heading')],
      sections: [section('a', [section('a1', [section('a1x')]), section('a2')]), section('b')],
    });
    const doc = await receiptOf(new FakeDocumentSink(), createReq(pkg));
    expect(doc.components.filter((c) => c.kind === 'section').map((c) => c.element)).toEqual([
      's~lead',
      'a',
      'a1',
      'a1x',
      'a2',
      'b',
    ]);
  });

  it('same key returns the first document', async () => {
    const sink = new FakeDocumentSink();
    const first = await receiptOf(sink, createReq());
    const again = await receiptOf(sink, createReq());
    expect(again).toEqual(first);
    expect(sink.documents.size).toBe(1);
  });

  it('a replayed key returns the receipt of its first write, not the current state', async () => {
    const sink = new FakeDocumentSink();
    const twoSections = withDocument({ sections: [section('a'), section('b')] });
    const created = await receiptOf(sink, createReq(twoSections));
    const b = created.components.find((c) => c.element === 'b')!;
    sink.edit('doc-1', b.id);
    expect(await receiptOf(sink, createReq(twoSections))).toEqual(created);

    const updated = await receiptOf(
      sink,
      updateReq(
        'doc-1',
        [...created.components.filter((c) => c !== b), { ...b, version: '2' }],
        twoSections,
      ),
    );
    sink.edit('doc-1', b.id);
    expect(await receiptOf(sink, createReq(twoSections))).toEqual(created);
    expect(await receiptOf(sink, updateReq('doc-1', created.components, twoSections))).toEqual(
      updated,
    );
    expect(sink.documents.size).toBe(1);
  });

  it('refuses a package without a document as unsupported_part', async () => {
    const error = await refusal(new FakeDocumentSink().deliver(deliverRequest()));
    expect(error).toMatchObject({ class: 'needs_user', code: 'unsupported_part' });
  });
});

describe('FakeDocumentSink, update', () => {
  const twoSections = withDocument({ sections: [section('a'), section('b')] });

  it('update with matching versions bumps sections', async () => {
    const sink = new FakeDocumentSink();
    const created = await receiptOf(sink, createReq(twoSections));
    const changed = withDocument({ sections: [section('a'), section('c')] });
    const updated = await receiptOf(sink, updateReq('doc-1', created.components, changed));
    expect(updated.persistentId).toBe('doc-1');
    expect(versions(updated.components)).toEqual({ map: '2', a: '2', c: '1' });
    expect(updated.components.find((c) => c.element === 'a')!.id).toBe(
      created.components.find((c) => c.element === 'a')!.id,
    );
    expect(updated.readBack.ok).toBe(true);
    // the same update retried returns the same receipt, without bumping again
    expect(await receiptOf(sink, updateReq('doc-1', created.components, changed))).toEqual(updated);
  });

  it('bumps an image only when its bytes changed', async () => {
    const sink = new FakeDocumentSink();
    const created = await receiptOf(sink, createReq());
    const [first, ...rest] = decomposed.images!;
    const pkg = {
      ...structuredClone(decomposed),
      images: [{ ...first!, content: Buffer.from('other bytes').toString('base64') }, ...rest],
    };
    const updated = await receiptOf(sink, updateReq('doc-1', created.components, pkg));
    expect(versions(updated.components)).toEqual({
      map: '2',
      's-figures': '2',
      [first!.id]: '2',
      ...Object.fromEntries(rest.map((i) => [i.id, '1'])),
    });
  });

  it('update after edit is refused as changed_in_target with the component', async () => {
    const sink = new FakeDocumentSink();
    const created = await receiptOf(sink, createReq(twoSections));
    const b = created.components.find((c) => c.element === 'b')!;
    expect(sink.edit('doc-1', b.id)).toMatchObject({ id: b.id, version: '2' });
    const error = await refusal(sink.deliver(updateReq('doc-1', created.components, twoSections)));
    expect(error).toMatchObject({
      class: 'needs_user',
      code: 'changed_in_target',
      details: { changed: [{ id: b.id, expected: '1', actual: '2' }] },
    });
    // nothing changed
    expect(sink.documents.get('doc-1')!.components.get(b.id)!.version).toBe(2);
    expect(sink.documents.get('doc-1')!.components.get(created.components[0]!.id)!.version).toBe(1);
  });

  it('update with an extra current component is refused', async () => {
    const sink = new FakeDocumentSink();
    const created = await receiptOf(sink, createReq(twoSections));
    const b = created.components.find((c) => c.element === 'b')!;
    const expected = created.components.filter((c) => c !== b);
    const error = await refusal(sink.deliver(updateReq('doc-1', expected, twoSections)));
    expect(error).toMatchObject({
      code: 'changed_in_target',
      details: { changed: [{ id: b.id, expected: 'none', actual: '1' }] },
    });
  });

  it('a missing expected component is refused as gone', async () => {
    const sink = new FakeDocumentSink();
    const created = await receiptOf(sink, createReq(twoSections));
    const ghost = { kind: 'section', id: 'doc-1/section/zz', version: '1', element: 'zz' };
    const error = await refusal(
      sink.deliver(updateReq('doc-1', [...created.components, ghost], twoSections)),
    );
    expect(error).toMatchObject({
      code: 'changed_in_target',
      details: { changed: [{ id: ghost.id, expected: '1', actual: null }] },
    });
  });

  it('unknown persistent id is refused as gone', async () => {
    const expected = [{ kind: 'map', id: 'doc-9/map', version: '3', element: null }];
    const error = await refusal(new FakeDocumentSink().deliver(updateReq('doc-9', expected)));
    expect(error).toMatchObject({
      class: 'needs_user',
      code: 'changed_in_target',
      details: { changed: [{ id: 'doc-9', expected: '3', actual: null }] },
    });
  });

  it('an update of a document deleted in the target is refused as not found', async () => {
    const sink = new FakeDocumentSink();
    const created = await receiptOf(sink, createReq(twoSections));
    expect(sink.remove('doc-1')).toBe(true);
    expect(sink.remove('doc-1')).toBe(false);
    expect(sink.documents.has('doc-1')).toBe(false);
    const error = await refusal(sink.deliver(updateReq('doc-1', created.components, twoSections)));
    expect(error).toMatchObject({
      class: 'needs_user',
      code: 'not_found',
      details: { reason: 'document_missing', persistentId: 'doc-1' },
    });
    expect(error.message).toContain('doc-1');
    // A create of the same file under a new key makes a new document.
    const again = await receiptOf(sink, createReq(twoSections, 'key-again'));
    expect(again.persistentId).toBe('doc-2');
  });

  it('changed details are capped', async () => {
    const sink = new FakeDocumentSink();
    const many = withDocument({
      sections: Array.from({ length: 500 }, (_, i) => section(`s-${i}`)),
    });
    const created = await receiptOf(sink, createReq(many));
    for (const c of created.components) if (c.kind === 'section') sink.edit('doc-1', c.id);
    const error = await refusal(sink.deliver(updateReq('doc-1', created.components, many)));
    const details = error.details as { changed: unknown[]; more: number };
    expect(details.changed.length).toBeLessThanOrEqual(40);
    expect(details.changed.length + details.more).toBe(500);
    expect(new TextEncoder().encode(JSON.stringify(error)).length).toBeLessThan(4096);
  });

  it('edit answers null for an unknown document or component', () => {
    const sink = new FakeDocumentSink();
    expect(sink.edit('doc-1', 'doc-1/map')).toBeNull();
  });
});

describe('FakeDocumentSink, read back', () => {
  it('read back compares the forms', async () => {
    const sink = new FakeDocumentSink();
    const clean = await receiptOf(sink, createReq());
    expect(clean.readBack).toEqual({ ok: true, at: null, detail: null });
    // the stored copy is a copy: changing what was delivered changes nothing stored
    expect(sink.documents.get('doc-1')!.document).toEqual(decomposed.document);
    expect(sink.documents.get('doc-1')!.document).not.toBe(decomposed.document);

    sink.corruptNextReadBack();
    const corrupt = await receiptOf(sink, createReq(decomposed, 'key-2'));
    expect(corrupt.readBack.ok).toBe(false);
    expect(corrupt.readBack.at).toMatch(/^text\[\d+\]$/);
    expect(corrupt.readBack.detail).toBeTruthy();

    // only the next one
    const after = await receiptOf(sink, createReq(decomposed, 'key-3'));
    expect(after.readBack.ok).toBe(true);
  });
});
