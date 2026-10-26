import {
  bridgeError,
  changedInTargetDetails,
  type BrowseResult,
  type ComponentVersion,
  type ConditionalUpdate,
  type ConnectionTestRequest,
  type ConnectionTestResult,
  type DecomposedDocument,
  gridForms,
  type Receipt,
  type Section,
  type SinkDeliverRequest,
  type SinkDeliverResult,
  type SinkDescribe,
  type SinkJobStatus,
  textForm,
} from '@ih/bridge-contract';
import { SinkError, type SinkPort } from './port.js';

type EquationForm = 'mathml' | 'latex' | 'image';
type DocumentReceipt = NonNullable<Receipt['document']>;

/** One component of a stored document; `element` is a section id, an image id, or null (the map). */
export interface StoredComponent {
  kind: 'map' | 'section' | 'image';
  element: string | null;
  version: number;
}

/** A document as the fake target holds it. */
export interface StoredDocument {
  idempotencyKeys: Set<string>;
  components: Map<string, StoredComponent>;
  /** The copy of the delivered document the target holds, read back after each write. */
  document: DecomposedDocument;
  /** Each image's bytes (base64), to tell a replaced image from an unchanged one. */
  imageBytes: Map<string, string>;
  /** The last write's read-back. */
  readBack: DocumentReceipt['readBack'];
}

/** The section that holds a document's leading blocks (content before the first heading). */
const LEAD = 's~lead';
/** The `expected` version listed for a current component the update did not expect. */
const NOT_EXPECTED = 'none';
/** How much of a differing text unit the read-back detail quotes. */
const QUOTED = 120;

const mapId = (pid: string) => `${pid}/map`;
const sectionId = (pid: string, id: string) => `${pid}/section/${id}`;
const imageId = (pid: string, id: string) => `${pid}/image/${id}`;

/** Every section id, depth first, with the leading blocks as `s~lead` when there are any. */
function sectionIds(doc: DecomposedDocument): string[] {
  const ids = doc.blocks.length ? [LEAD] : [];
  const walk = (s: Section) => {
    ids.push(s.id);
    s.sections.forEach(walk);
  };
  doc.sections.forEach(walk);
  return ids;
}

const quote = (s: string | undefined) =>
  s === undefined ? 'nothing' : JSON.stringify(s.length > QUOTED ? `${s.slice(0, QUOTED)}…` : s);

/** Where the stored copy's comparison forms first differ from the delivered document's. */
function compareForms(
  stored: DecomposedDocument,
  delivered: DecomposedDocument,
): DocumentReceipt['readBack'] {
  const [got, sent] = [textForm(stored), textForm(delivered)];
  for (let i = 0; i < Math.max(got.length, sent.length); i += 1) {
    if (got[i] !== sent[i]) {
      return {
        ok: false,
        at: `text[${i}]`,
        detail: `sent ${quote(sent[i])}, read ${quote(got[i])}`,
      };
    }
  }
  const [gotGrids, sentGrids] = [gridForms(stored), gridForms(delivered)];
  for (const id of new Set([...Object.keys(sentGrids), ...Object.keys(gotGrids)])) {
    if (JSON.stringify(gotGrids[id]) !== JSON.stringify(sentGrids[id])) {
      return { ok: false, at: `table ${id}`, detail: 'the table grid differs' };
    }
  }
  return { ok: true, at: null, detail: null };
}

/**
 * A stateful fake target for decomposed documents: the reference for how a real document sink
 * behaves. It assigns persistent ids (`doc-<n>`), versions every component (the document's map,
 * each section, each image), writes idempotently by key (a replayed key gets the receipt of its
 * first write, never the current state), refuses a conditional update when any
 * component changed (`changed_in_target`), refuses an update of a document deleted in the
 * target (`not_found`, as a real target does), and reads each write back through the shared
 * comparison forms. `edit`, `remove` and `corruptNextReadBack` stand for what happens in a real
 * target.
 */
export class FakeDocumentSink implements SinkPort {
  readonly documents = new Map<string, StoredDocument>();
  private readonly equations: EquationForm[];
  /** The receipt each idempotency key's write produced, returned as it was on a replay. */
  private readonly receipts = new Map<string, SinkDeliverResult>();
  private created = 0;
  private corruptNext = false;
  /** The documents someone deleted in the target (`remove`). */
  private readonly deleted = new Set<string>();

  constructor(opts: { equations?: EquationForm[] } = {}) {
    this.equations = opts.equations ?? ['mathml', 'latex', 'image'];
  }

  async describe(): Promise<SinkDescribe> {
    return {
      name: 'Fake document sink',
      contractVersion: 2,
      connectionKind: 'shared',
      instances: [],
      credentialFields: [],
      destinationFields: [
        {
          id: 'space',
          label: 'Space',
          kind: 'fixed',
          required: true,
          overridable: false,
          browse: false,
        },
      ],
      capabilities: {
        browse: false,
        replace: true,
        withdraw: false,
        readBack: true,
        accepts: ['document', 'images'],
        decomposedDocuments: { equations: [...this.equations] },
      },
    };
  }

  async testConnection(req: ConnectionTestRequest): Promise<ConnectionTestResult> {
    return { ok: true, identity: `fake:${req.credential.username ?? 'user'}` };
  }

  async browse(): Promise<BrowseResult> {
    return { nodes: [], nextCursor: null };
  }

  async deliveryStatus(sinkJobId: string): Promise<SinkJobStatus> {
    throw new SinkError(bridgeError('not_found', `no sink job ${sinkJobId}`));
  }

  /** The test hook: one component changes in the target. Null if there is no such component. */
  edit(persistentId: string, componentId: string): ComponentVersion | null {
    const component = this.documents.get(persistentId)?.components.get(componentId);
    if (!component) return null;
    component.version += 1;
    return {
      kind: component.kind,
      id: componentId,
      version: `${component.version}`,
      element: component.element,
    };
  }

  /** The test hook: someone deletes a document in the target. False if there is no such one. */
  remove(persistentId: string): boolean {
    if (!this.documents.delete(persistentId)) return false;
    this.deleted.add(persistentId);
    return true;
  }

  /** The test hook: the next write's read-back finds a difference. */
  corruptNextReadBack(): void {
    this.corruptNext = true;
  }

  async deliver(req: SinkDeliverRequest): Promise<SinkDeliverResult> {
    const delivered = req.package.document;
    if (!delivered) {
      throw new SinkError(
        bridgeError('unsupported_part', 'this sink takes only decomposed documents'),
      );
    }
    // A key seen before is a retry: it gets the receipt its first write produced, never the
    // document's current state (that may hold a change made in the target since).
    const replayed = this.receipts.get(req.idempotencyKey);
    if (replayed) return structuredClone(replayed);
    const images = new Map((req.package.images ?? []).map((i) => [i.id, i.content]));
    if (req.update) {
      const pid = req.update.persistentId;
      this.check(req.update);
      const stored = this.documents.get(pid)!;
      stored.components = this.bumped(pid, stored, delivered, images);
      this.write(stored, req.idempotencyKey, delivered, images);
      return this.receipt(req.idempotencyKey, pid, stored);
    }
    const pid = `doc-${++this.created}`;
    const components = new Map<string, StoredComponent>([
      [mapId(pid), { kind: 'map', element: null, version: 1 }],
    ]);
    for (const id of sectionIds(delivered)) {
      components.set(sectionId(pid, id), { kind: 'section', element: id, version: 1 });
    }
    for (const { id } of delivered.images) {
      components.set(imageId(pid, id), { kind: 'image', element: id, version: 1 });
    }
    const stored: StoredDocument = {
      idempotencyKeys: new Set(),
      components,
      document: delivered,
      imageBytes: images,
      readBack: { ok: true, at: null, detail: null },
    };
    this.documents.set(pid, stored);
    this.write(stored, req.idempotencyKey, delivered, images);
    return this.receipt(req.idempotencyKey, pid, stored);
  }

  /** Refuses the update unless the target holds exactly the expected components at their versions. */
  private check(update: ConditionalUpdate): void {
    const stored = this.documents.get(update.persistentId);
    if (!stored && this.deleted.has(update.persistentId)) {
      throw new SinkError(
        bridgeError(
          'not_found',
          `the target has no document ${update.persistentId} for this update to replace`,
        ),
      );
    }
    if (!stored) {
      const map = update.expected.find((c) => c.kind === 'map') ?? update.expected[0]!;
      throw new SinkError(
        bridgeError(
          'changed_in_target',
          `document ${update.persistentId} is gone from the target`,
          changedInTargetDetails([
            { id: update.persistentId, expected: map.version, actual: null },
          ]),
        ),
      );
    }
    const changed: Array<{ id: string; expected: string; actual: string | null }> = [];
    const expectedIds = new Set<string>();
    for (const e of update.expected) {
      expectedIds.add(e.id);
      const current = stored.components.get(e.id);
      const actual = current ? `${current.version}` : null;
      if (actual !== e.version) changed.push({ id: e.id, expected: e.version, actual });
    }
    for (const [id, current] of stored.components) {
      if (!expectedIds.has(id)) {
        changed.push({ id, expected: NOT_EXPECTED, actual: `${current.version}` });
      }
    }
    if (changed.length) {
      throw new SinkError(
        bridgeError(
          'changed_in_target',
          `${changed.length} component(s) of ${update.persistentId} changed in the target`,
          changedInTargetDetails(changed),
        ),
      );
    }
  }

  /**
   * The components after an update: the map and every surviving section at a new version, new
   * sections at 1, removed ones dropped; an image at a new version only if its bytes changed.
   */
  private bumped(
    pid: string,
    stored: StoredDocument,
    delivered: DecomposedDocument,
    images: Map<string, string>,
  ): Map<string, StoredComponent> {
    const before = stored.components;
    const next = (id: string) => (before.get(id)?.version ?? 0) + 1;
    const components = new Map<string, StoredComponent>([
      [mapId(pid), { kind: 'map', element: null, version: next(mapId(pid)) }],
    ]);
    for (const id of sectionIds(delivered)) {
      const cid = sectionId(pid, id);
      components.set(cid, { kind: 'section', element: id, version: next(cid) });
    }
    for (const { id } of delivered.images) {
      const cid = imageId(pid, id);
      const kept = before.get(cid);
      const same = kept && stored.imageBytes.get(id) === images.get(id);
      components.set(cid, { kind: 'image', element: id, version: same ? kept.version : next(cid) });
    }
    return components;
  }

  /** Stores a copy of the delivered document and reads it back. */
  private write(
    stored: StoredDocument,
    key: string,
    delivered: DecomposedDocument,
    images: Map<string, string>,
  ): void {
    stored.idempotencyKeys.add(key);
    stored.imageBytes = images;
    stored.document = structuredClone(delivered);
    if (this.corruptNext) {
      this.corruptNext = false;
      stored.document.blocks.push({
        kind: 'paragraph',
        id: `${LEAD}#corrupt`,
        inlines: [{ kind: 'text', text: 'not what was sent', marks: [] }],
      });
    }
    stored.readBack = compareForms(stored.document, delivered);
  }

  /** The receipt of the write just made under `key`, kept for that key's replays. */
  private receipt(key: string, pid: string, stored: StoredDocument): SinkDeliverResult {
    const components = [...stored.components].map(([id, c]) => ({
      kind: c.kind,
      id,
      version: `${c.version}`,
      element: c.element,
    }));
    const result: SinkDeliverResult = {
      status: 'succeeded',
      receipt: {
        written: [{ kind: 'document', id: pid, label: null, url: null }],
        document: { persistentId: pid, components, readBack: { ...stored.readBack } },
      },
    };
    this.receipts.set(key, structuredClone(result));
    return result;
  }
}
