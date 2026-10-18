import { randomUUID } from 'node:crypto';
import {
  answerKey,
  answerTerms,
  type MappingMemoryEntry,
  type MemoryListQuery,
  type MemoryStatus,
  type RememberedAnswer,
  type SignatureKind,
} from '@ih/shared';

/**
 * The mapping memory (docs/design/mapping-memory.md, migration 202610181509_mapping_memory):
 * entries (a signature and an accepted answer), one vote per recipe and output, refusals and
 * reviews. The routes add what needs the ontology library (stale entries, term labels).
 */

/** One output of a recipe and the answer its newest version gives it. */
export interface VoteInput {
  path: string;
  kind: SignatureKind;
  signatureKey: string;
  name: string;
  description: string;
  type: string;
  unit: string;
  table: string | null;
  answer: RememberedAnswer;
  ontologies: string[];
  version: number;
  /** The recipe's project allows external models. */
  external: boolean;
}

export interface ReplaceResult {
  /** Outputs whose pre-selected answer the recipe no longer gives: a refusal each. */
  refused: number;
}

/** An entry made or confirmed by hand on the Ontologies page. */
export interface EntryInput {
  kind: SignatureKind;
  signatureKey: string;
  name: string;
  description: string;
  type: string;
  unit: string;
  answer: RememberedAnswer;
  ontologies: string[];
  note: string | null;
  external: boolean;
}

export interface EntryPatch {
  status?: MemoryStatus;
  answer?: RememberedAnswer;
  note?: string | null;
}

export interface MappingMemoryRepo {
  /**
   * The recipe's votes become these (one per path; none removes them): entries are found or
   * made by signature and answer, an output whose vote had an origin (the entry it was
   * pre-selected from) and now gives another answer, or none, refuses that entry, and an entry
   * left without votes, refusals or a review is deleted.
   */
  replaceVotes(templateId: string, votes: VoteInput[], by: string | null): Promise<ReplaceResult>;
  /** Marks the recipe's votes as pre-selected from these entries (path -> entry id). */
  setOrigins(templateId: string, origins: Record<string, string>): Promise<void>;
  /** A designer chose otherwise when the entry was offered (once per recipe and output). */
  addRefusal(entryId: string, templateId: string, path: string, by: string | null): Promise<void>;
  list(query: MemoryListQuery): Promise<{ entries: MappingMemoryEntry[]; total: number }>;
  get(id: string): Promise<MappingMemoryEntry | null>;
  /** Adds an entry by hand (confirmed); an existing one with the same answer is confirmed. */
  create(input: EntryInput, by: string | null): Promise<MappingMemoryEntry>;
  /** Null for an unknown entry; 'conflict' when the edited answer already has an entry. */
  patch(
    id: string,
    patch: EntryPatch,
    by: string | null,
  ): Promise<MappingMemoryEntry | null | 'conflict'>;
  delete(id: string): Promise<boolean>;
  /** Every recipe id with votes (for the reconcile). */
  votedTemplates(): Promise<string[]>;
}

interface Row {
  id: string;
  kind: SignatureKind;
  signatureKey: string;
  name: string;
  description: string;
  type: string;
  unit: string;
  answer: RememberedAnswer;
  answerKey: string;
  ontologies: string[];
  status: MemoryStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  note: string | null;
  reviewedExternal: boolean;
  createdAt: string;
  updatedAt: string;
}

interface VoteRow {
  templateId: string;
  path: string;
  entryId: string;
  version: number;
  name: string;
  description: string;
  table: string | null;
  external: boolean;
  originEntryId: string | null;
}

interface RefusalRow {
  entryId: string;
  templateId: string;
  path: string;
}

const PAGE_SIZE = 50;

/** The list's status filter: `review` = learned (designers have not vouched for it yet). */
export function statusMatches(status: MemoryStatus, filter: MemoryListQuery['status']): boolean {
  if (!filter || filter === 'all') return true;
  return filter === 'review' ? status === 'learned' : status === filter;
}

/** In-memory repo for tests; same contract as PgMappingMemoryRepo (mapping-memory-contract.ts). */
export class MemoryMappingMemoryRepo implements MappingMemoryRepo {
  readonly rows = new Map<string, Row>();
  readonly votes: VoteRow[] = [];
  readonly refusals: RefusalRow[] = [];
  private tick = Date.parse('2026-10-18T12:00:00Z');

  private now(): string {
    this.tick += 1000;
    return new Date(this.tick).toISOString();
  }

  private findOrMake(input: Omit<EntryInput, 'note' | 'external'>): Row {
    const key = answerKey(input.answer);
    const found = [...this.rows.values()].find(
      (r) => r.signatureKey === input.signatureKey && r.answerKey === key,
    );
    if (found) {
      found.ontologies = [...new Set([...found.ontologies, ...input.ontologies])].sort();
      return found;
    }
    const at = this.now();
    const row: Row = {
      id: randomUUID(),
      kind: input.kind,
      signatureKey: input.signatureKey,
      name: input.name,
      description: input.description,
      type: input.type,
      unit: input.unit,
      answer: input.answer,
      answerKey: key,
      ontologies: [...new Set(input.ontologies)].sort(),
      status: 'learned',
      reviewedBy: null,
      reviewedAt: null,
      note: null,
      reviewedExternal: false,
      createdAt: at,
      updatedAt: at,
    };
    this.rows.set(row.id, row);
    return row;
  }

  private prune(): void {
    for (const row of [...this.rows.values()]) {
      const used =
        this.votes.some((v) => v.entryId === row.id) ||
        this.refusals.some((r) => r.entryId === row.id);
      if (!used && row.reviewedBy === null && row.status === 'learned') this.rows.delete(row.id);
    }
  }

  async replaceVotes(templateId: string, votes: VoteInput[], by: string | null) {
    const before = new Map(
      this.votes.filter((v) => v.templateId === templateId).map((v) => [v.path, v]),
    );
    for (let i = this.votes.length - 1; i >= 0; i--) {
      if (this.votes[i]!.templateId === templateId) this.votes.splice(i, 1);
    }
    const after = new Map<string, string>();
    for (const v of votes) {
      const row = this.findOrMake(v);
      const old = before.get(v.path);
      this.votes.push({
        templateId,
        path: v.path,
        entryId: row.id,
        version: v.version,
        name: v.name,
        description: v.description,
        table: v.table,
        external: v.external,
        originEntryId: old && old.originEntryId === row.id ? row.id : null,
      });
      after.set(v.path, row.id);
    }
    let refused = 0;
    for (const [path, old] of before) {
      if (old.originEntryId && after.get(path) !== old.originEntryId) {
        await this.addRefusal(old.originEntryId, templateId, path, by);
        refused += 1;
      }
    }
    this.prune();
    return { refused };
  }

  async setOrigins(templateId: string, origins: Record<string, string>) {
    for (const v of this.votes) {
      if (v.templateId === templateId && origins[v.path] === v.entryId) v.originEntryId = v.entryId;
    }
  }

  async addRefusal(entryId: string, templateId: string, path: string, _by: string | null) {
    if (!this.rows.has(entryId)) return;
    const exists = this.refusals.some(
      (r) => r.entryId === entryId && r.templateId === templateId && r.path === path,
    );
    if (!exists) this.refusals.push({ entryId, templateId, path });
  }

  private view(row: Row): MappingMemoryEntry {
    const votes = this.votes.filter((v) => v.entryId === row.id);
    const refusals = new Set(
      this.refusals.filter((r) => r.entryId === row.id).map((r) => r.templateId),
    );
    return {
      id: row.id,
      kind: row.kind,
      signatureKey: row.signatureKey,
      name: row.name,
      description: row.description,
      type: row.type,
      unit: row.unit,
      answer: row.answer,
      ontologies: row.ontologies,
      status: row.status,
      stale: null,
      votes: new Set(votes.map((v) => v.templateId)).size,
      refusals: refusals.size,
      recipes: votes
        .map((v) => ({ id: v.templateId, path: v.path, version: v.version }))
        .sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path)),
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      note: row.note,
      updatedAt: row.updatedAt,
    };
  }

  async list(query: MemoryListQuery) {
    const q = query.q?.trim().toLowerCase();
    const all = [...this.rows.values()]
      .filter((r) => statusMatches(r.status, query.status))
      .filter((r) => !query.ontology || r.ontologies.includes(query.ontology))
      .filter((r) => !query.term || answerTerms(r.answer).includes(query.term))
      .filter(
        (r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
      )
      .map((r) => this.view(r))
      .sort(
        (a, b) => b.votes - a.votes || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      );
    const size = query.pageSize ?? PAGE_SIZE;
    const page = query.page ?? 1;
    return { entries: all.slice((page - 1) * size, page * size), total: all.length };
  }

  async get(id: string) {
    const row = this.rows.get(id);
    return row ? this.view(row) : null;
  }

  async create(input: EntryInput, by: string | null) {
    const row = this.findOrMake(input);
    row.status = 'confirmed';
    row.reviewedBy = by;
    row.reviewedAt = this.now();
    row.updatedAt = row.reviewedAt;
    row.note = input.note;
    row.reviewedExternal = row.reviewedExternal || input.external;
    return this.view(row);
  }

  async patch(id: string, patch: EntryPatch, by: string | null) {
    const row = this.rows.get(id);
    if (!row) return null;
    if (patch.answer) {
      const key = answerKey(patch.answer);
      const clash = [...this.rows.values()].find(
        (r) => r.id !== id && r.signatureKey === row.signatureKey && r.answerKey === key,
      );
      if (clash) return 'conflict' as const;
      row.answer = patch.answer;
      row.answerKey = key;
      row.status = 'confirmed';
    }
    if (patch.status) row.status = patch.status;
    if (patch.note !== undefined) row.note = patch.note;
    row.reviewedBy = by;
    row.reviewedAt = this.now();
    row.updatedAt = row.reviewedAt;
    return this.view(row);
  }

  async delete(id: string) {
    const had = this.rows.delete(id);
    for (let i = this.votes.length - 1; i >= 0; i--) {
      if (this.votes[i]!.entryId === id) this.votes.splice(i, 1);
    }
    for (let i = this.refusals.length - 1; i >= 0; i--) {
      if (this.refusals[i]!.entryId === id) this.refusals.splice(i, 1);
    }
    return had;
  }

  async votedTemplates() {
    return [...new Set(this.votes.map((v) => v.templateId))].sort();
  }
}
