import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const S3KeyStatusSchema = z.enum(['active', 'expired', 'revoked']);
export type S3KeyStatus = z.infer<typeof S3KeyStatusSchema>;

/** An S3 access key as listed to admins: never its secret (SeaweedFS holds that, ADR 0008). */
export const S3KeySchema = z.object({
  id: z.string().uuid(),
  accessKeyId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  status: S3KeyStatusSchema,
});
export type S3Key = z.infer<typeof S3KeySchema>;

/** A data-lake consumer: one SeaweedFS user, at most two active keys (newest first). */
export const S3ConsumerSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  userName: z.string().describe('The SeaweedFS identity: `lake-{id}`.'),
  createdAt: z.string(),
  keys: z.array(S3KeySchema).describe('Newest first; at most two active.'),
  targets: z
    .array(z.string())
    .describe('The internal publishing targets (ids) its keys may read, sorted.'),
});
export type S3Consumer = z.infer<typeof S3ConsumerSchema>;

/** Consumer and key metadata. `PgS3KeyRepo` (migration 0010) / `MemoryS3KeyRepo`. */
export interface S3KeyRepo {
  createConsumer(id: string, label: string, userName: string): Promise<void>;
  /** `expiresInDays` null = never; `rotatedFrom` = the key this one replaces. */
  addKey(
    consumerId: string,
    accessKeyId: string,
    expiresInDays: number | null,
    rotatedFrom: string | null,
  ): Promise<S3Key>;
  listConsumers(): Promise<S3Consumer[]>;
  getConsumer(id: string): Promise<S3Consumer | null>;
  findKey(id: string): Promise<{ key: S3Key; consumerId: string; userName: string } | null>;
  revokeKey(id: string): Promise<void>;
  /** Make the consumer's active keys (except `exceptKeyId`) expire within `days`, never later. */
  capExpiry(consumerId: string, days: number, exceptKeyId: string): Promise<void>;
  deleteConsumer(id: string): Promise<void>;
  /** The publishing target ids the consumer may read, sorted. */
  grants(consumerId: string): Promise<string[]>;
  /** Replace the consumer's grants. */
  setGrants(consumerId: string, targetIds: string[]): Promise<void>;
}

interface KeyRow {
  id: string;
  consumerId: string;
  accessKeyId: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  rotatedFrom: string | null;
}

const DAY = 86_400_000;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** In-memory consumer and key metadata for unit tests (injectable clock). */
export class MemoryS3KeyRepo implements S3KeyRepo {
  private readonly consumers = new Map<
    string,
    { id: string; label: string; userName: string; createdAt: number }
  >();
  private readonly keys = new Map<string, KeyRow>();
  private readonly granted = new Map<string, string[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async createConsumer(id: string, label: string, userName: string): Promise<void> {
    this.consumers.set(id, { id, label, userName, createdAt: this.now() });
  }

  async addKey(
    consumerId: string,
    accessKeyId: string,
    expiresInDays: number | null,
    rotatedFrom: string | null,
  ): Promise<S3Key> {
    const row: KeyRow = {
      id: randomUUID(),
      consumerId,
      accessKeyId,
      createdAt: this.now(),
      expiresAt: expiresInDays === null ? null : this.now() + expiresInDays * DAY,
      revokedAt: null,
      rotatedFrom,
    };
    this.keys.set(row.id, row);
    return this.view(row);
  }

  async listConsumers(): Promise<S3Consumer[]> {
    return [...this.consumers.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => this.consumerView(c.id)!);
  }

  async getConsumer(id: string): Promise<S3Consumer | null> {
    return this.consumerView(id);
  }

  async findKey(id: string) {
    const row = this.keys.get(id);
    const consumer = row && this.consumers.get(row.consumerId);
    if (!row || !consumer) return null;
    return { key: this.view(row), consumerId: consumer.id, userName: consumer.userName };
  }

  async revokeKey(id: string): Promise<void> {
    const row = this.keys.get(id);
    if (row) row.revokedAt ??= this.now();
  }

  async capExpiry(consumerId: string, days: number, exceptKeyId: string): Promise<void> {
    const cap = this.now() + days * DAY;
    for (const row of this.keys.values()) {
      if (row.consumerId !== consumerId || row.id === exceptKeyId || !this.active(row)) continue;
      row.expiresAt = row.expiresAt === null ? cap : Math.min(row.expiresAt, cap);
    }
  }

  async grants(consumerId: string): Promise<string[]> {
    return [...(this.granted.get(consumerId) ?? [])];
  }

  async setGrants(consumerId: string, targetIds: string[]): Promise<void> {
    this.granted.set(consumerId, [...new Set(targetIds)].sort());
  }

  /** Test inspection: how many consumers may read the target (for the target's usage). */
  grantCount(targetId: string): number {
    return [...this.granted.values()].filter((g) => g.includes(targetId)).length;
  }

  async deleteConsumer(id: string): Promise<void> {
    this.granted.delete(id);
    this.consumers.delete(id);
    for (const [keyId, row] of this.keys) if (row.consumerId === id) this.keys.delete(keyId);
  }

  private active(row: KeyRow): boolean {
    return row.revokedAt === null && (row.expiresAt === null || row.expiresAt > this.now());
  }

  private consumerView(id: string): S3Consumer | null {
    const c = this.consumers.get(id);
    if (!c) return null;
    const keys = [...this.keys.values()]
      .filter((k) => k.consumerId === id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((k) => this.view(k));
    return {
      id: c.id,
      label: c.label,
      userName: c.userName,
      createdAt: new Date(c.createdAt).toISOString(),
      keys,
      targets: [...(this.granted.get(id) ?? [])],
    };
  }

  private view(row: KeyRow): S3Key {
    const status: S3KeyStatus =
      row.revokedAt !== null ? 'revoked' : this.active(row) ? 'active' : 'expired';
    return {
      id: row.id,
      accessKeyId: row.accessKeyId,
      createdAt: new Date(row.createdAt).toISOString(),
      expiresAt: iso(row.expiresAt),
      revokedAt: iso(row.revokedAt),
      status,
    };
  }
}
