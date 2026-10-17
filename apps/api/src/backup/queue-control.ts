import type pg from 'pg';
import type { QueueControlView } from '@ih/shared';

/**
 * The job queue's pause switch (`queue_control`, migration 202610171218): while it is paused no
 * worker claims a job. A restore pauses it; an admin resumes it from Administration > Backup.
 */
export interface QueueControlRepo {
  get(): Promise<QueueControlView>;
  /**
   * Pausing records who, when and why (kept while it stays paused); resuming clears them and
   * wakes idle workers (NOTIFY ih_jobs), which would otherwise wait for their next poll.
   */
  set(paused: boolean, by: string | null, reason?: string | null): Promise<QueueControlView>;
}

const RUNNING: QueueControlView = { paused: false, pausedAt: null, pausedBy: null, reason: null };

export class MemoryQueueControlRepo implements QueueControlRepo {
  private view: QueueControlView = RUNNING;
  /** How many times idle workers were woken (a resume). */
  wakes = 0;

  async get(): Promise<QueueControlView> {
    return this.view;
  }

  async set(paused: boolean, by: string | null, reason: string | null = null) {
    if (!paused) {
      this.view = RUNNING;
      this.wakes += 1;
      return this.view;
    }
    this.view = this.view.paused
      ? this.view
      : { paused: true, pausedAt: new Date().toISOString(), pausedBy: by, reason };
    return this.view;
  }
}

interface Row {
  paused: boolean;
  paused_at: Date | null;
  paused_by: string | null;
  reason: string | null;
}

const toView = (r: Row): QueueControlView => ({
  paused: r.paused,
  pausedAt: r.paused_at?.toISOString() ?? null,
  pausedBy: r.paused_by,
  reason: r.reason,
});

export class PgQueueControlRepo implements QueueControlRepo {
  constructor(private readonly pool: pg.Pool) {}

  async get(): Promise<QueueControlView> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM queue_control');
    return rows[0] ? toView(rows[0]) : RUNNING;
  }

  async set(paused: boolean, by: string | null, reason: string | null = null) {
    if (!paused) {
      const { rows } = await this.pool.query<Row>(
        `WITH resumed AS (
           UPDATE queue_control SET paused = false, paused_at = NULL, paused_by = NULL,
             reason = NULL
           RETURNING *)
         SELECT resumed.*, pg_notify('ih_jobs', 'resumed') FROM resumed`,
      );
      return rows[0] ? toView(rows[0]) : RUNNING;
    }
    // Already paused: the first pause's who, when and why stay.
    const { rows } = await this.pool.query<Row>(
      `UPDATE queue_control SET paused = true,
         paused_at = CASE WHEN paused THEN paused_at ELSE now() END,
         paused_by = CASE WHEN paused THEN paused_by ELSE $1 END,
         reason = CASE WHEN paused THEN reason ELSE $2 END
       RETURNING *`,
      [by, reason],
    );
    return rows[0] ? toView(rows[0]) : RUNNING;
  }
}
