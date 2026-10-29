import { createHash } from 'node:crypto';
import {
  bridgeError,
  FOLDER_MISSING_REASON,
  documentMissing,
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
  type BrowseRequest,
  type SourceFile,
  type SourceFolder,
  textForm,
} from '@ih/bridge-contract';
import { SinkError, sourceTooLarge, type SinkPort, type SourcePort } from './port.js';

/** The watched location the fake holds from the start (source field `folder`). */
export const FAKE_SOURCE = 'inbox';

/** One file in a watched folder. */
interface HeldFile {
  bytes: Buffer;
  modifiedAt: string;
}

/** A watched location: its four folders, each a map of file name to file. */
type Location = Record<SourceFolder, Map<string, HeldFile>>;

const emptyLocation = (): Location => ({
  '': new Map(),
  processing: new Map(),
  delivered: new Map(),
  failed: new Map(),
});

const fileOf = (name: string, f: HeldFile): SourceFile => ({
  name,
  size: f.bytes.length,
  modifiedAt: f.modifiedAt,
  etag: createHash('md5').update(f.bytes).digest('hex'),
});

const byName = (a: SourceFile, b: SourceFile) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

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
 * target (`not_found` with the missing-document marker, `documentMissing`, as a real sink
 * does), and reads each write back through the shared comparison forms. `edit`, `remove` and `corruptNextReadBack` stand for what happens in a real
 * target. It also has watched folders (contract version 4, one instance `main` with 2 lanes): the
 * locations named by the source field `folder`, `inbox` from the start, where `drop` puts a file.
 */
export class FakeDocumentSink implements SinkPort {
  readonly documents = new Map<string, StoredDocument>();
  /** Every watched folder call, with the credential it came with. */
  readonly sourceCalls: Array<{ op: keyof SourcePort; credential: Record<string, string> }> = [];
  /** The watched locations, by the value of the source field `folder`. */
  private readonly locations = new Map<string, Location>([[FAKE_SOURCE, emptyLocation()]]);
  private readonly equations: EquationForm[];
  private readonly connectionKind: 'shared' | 'personal';
  /** The receipt each idempotency key's write produced, returned as it was on a replay. */
  private readonly receipts = new Map<string, SinkDeliverResult>();
  private created = 0;
  private corruptNext = false;
  /** The documents someone deleted in the target (`remove`). */
  private readonly deleted = new Set<string>();

  constructor(opts: { equations?: EquationForm[]; connectionKind?: 'shared' | 'personal' } = {}) {
    this.equations = opts.equations ?? ['mathml', 'latex', 'image'];
    this.connectionKind = opts.connectionKind ?? 'shared';
  }

  async describe(): Promise<SinkDescribe> {
    const personal = this.connectionKind === 'personal';
    return {
      name: 'Fake document sink',
      contractVersion: 4,
      connectionKind: this.connectionKind,
      instances: [{ id: 'main', label: 'Main', lanes: 2 }],
      credentialFields: personal
        ? [
            { id: 'username', label: 'User name', secret: false },
            { id: 'password', label: 'Password', secret: true },
          ]
        : [],
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
        browse: true,
        replace: true,
        withdraw: false,
        readBack: true,
        accepts: ['document', 'images'],
        decomposedDocuments: { equations: [...this.equations] },
        watchedFolders: {
          sourceFields: [
            {
              id: 'folder',
              label: 'Folder',
              kind: 'fixed',
              required: true,
              overridable: false,
              browse: true,
            },
          ],
        },
      },
    };
  }

  async testConnection(req: ConnectionTestRequest): Promise<ConnectionTestResult> {
    return { ok: true, identity: `fake:${req.credential.username ?? 'user'}` };
  }

  /** Only the source field `folder` browses: its watched locations, one level. */
  async browse(req?: BrowseRequest): Promise<BrowseResult> {
    if (req?.scope !== 'source' || req.field !== 'folder' || req.parentId !== null) {
      return { nodes: [], nextCursor: null };
    }
    const nodes = [...this.locations.keys()].sort().map((id) => ({
      id,
      label: id,
      kind: 'folder',
      hasChildren: false,
      selectable: true,
    }));
    return { nodes, nextCursor: null };
  }

  /** The test hook: a file arrives in a location's root (a new location appears with it). */
  drop(name: string, bytes: Buffer, location = FAKE_SOURCE): void {
    let held = this.locations.get(location);
    if (!held) this.locations.set(location, (held = emptyLocation()));
    held[''].set(name, { bytes, modifiedAt: new Date().toISOString() });
  }

  /** The test hook: what one folder of a location holds, or null for an unknown location. */
  folder(folder: SourceFolder, location = FAKE_SOURCE): SourceFile[] | null {
    const held = this.locations.get(location);
    if (!held) return null;
    return [...held[folder]].map(([name, f]) => fileOf(name, f)).sort(byName);
  }

  /**
   * Contract version 4 in memory: a location named by the source field `folder` has the four
   * folders (empty until a file arrives); an unknown one is `folder_missing`. A move follows the
   * contract's idempotent rule (`SourceMoveRequestSchema`): a retried one (the source gone, the
   * destination there) succeeds, a destination of the same size takes the source's place, and one of
   * another size is `destination_exists` with nothing changed.
   */
  readonly sources: SourcePort = {
    list: async (r) => {
      this.sourceCalls.push({ op: 'list', credential: r.credential });
      return this.folder(r.folder, this.locationOf(r.source))!;
    },
    read: async (r, maxBytes) => {
      this.sourceCalls.push({ op: 'read', credential: r.credential });
      const held = this.held(r.source)[r.folder].get(r.name);
      if (!held) throw new SinkError(bridgeError('not_found', `there is no file ${r.name}`));
      if (held.bytes.length > maxBytes) throw sourceTooLarge(maxBytes);
      return Buffer.from(held.bytes);
    },
    move: async (r) => {
      this.sourceCalls.push({ op: 'move', credential: r.credential });
      const held = this.held(r.source);
      const file = held[r.from.folder].get(r.from.name);
      if (!file) {
        if (held[r.to.folder].has(r.to.name)) return;
        throw new SinkError(bridgeError('not_found', `there is no file ${r.from.name}`));
      }
      const there = held[r.to.folder].get(r.to.name);
      if (there && there !== file) {
        if (there.bytes.length !== file.bytes.length) {
          throw new SinkError(
            bridgeError('destination_exists', `${r.to.name} is already in ${r.to.folder}`),
          );
        }
        held[r.from.folder].delete(r.from.name);
        return;
      }
      held[r.from.folder].delete(r.from.name);
      held[r.to.folder].set(r.to.name, file);
    },
    put: async (r) => {
      this.sourceCalls.push({ op: 'put', credential: r.credential });
      this.held(r.source)[r.folder].set(r.name, {
        bytes: Buffer.from(r.content, 'utf8'),
        modifiedAt: new Date().toISOString(),
      });
    },
  };

  /** The location a request names, or `folder_missing`. */
  private locationOf(source: Record<string, string>): string {
    const location = source.folder ?? '';
    if (!this.locations.has(location)) {
      throw new SinkError(
        bridgeError('not_found', `there is no folder ${location}`, {
          reason: FOLDER_MISSING_REASON,
        }),
      );
    }
    return location;
  }

  private held(source: Record<string, string>): Location {
    return this.locations.get(this.locationOf(source))!;
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
        documentMissing(
          update.persistentId,
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
