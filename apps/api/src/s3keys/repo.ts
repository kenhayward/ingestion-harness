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

  async deleteConsumer(id: string): Promise<void> {
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
