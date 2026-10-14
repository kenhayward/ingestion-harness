import pg from 'pg';

/**
 * Tells the API a job changed (its row, a new event or step run), so a live stream
 * (`GET /api/jobs/:id/events`) re-reads it at once. Advisory: a stream also re-reads on each
 * heartbeat, so a lost notification only delays an update.
 */
export interface JobWatch {
  /** Calls `onChange` whenever job `jobId` may have changed; returns the unsubscribe. */
  subscribe(jobId: string, onChange: () => void): () => void;
  close(): Promise<void>;
}

/** Postgres channel the `jobs_notify_changed` triggers notify (migration 0031); payload: job id. */
export const JOB_CHANGED_CHANNEL = 'ih_job_changed';

class Listeners {
  private readonly byJob = new Map<string, Set<() => void>>();

  add(jobId: string, onChange: () => void): () => void {
    const set = this.byJob.get(jobId) ?? new Set();
    set.add(onChange);
    this.byJob.set(jobId, set);
    return () => {
      set.delete(onChange);
      if (!set.size) this.byJob.delete(jobId);
    };
  }

  fire(jobId: string): void {
    for (const onChange of [...(this.byJob.get(jobId) ?? [])]) onChange();
  }

  fireAll(): void {
    for (const jobId of [...this.byJob.keys()]) this.fire(jobId);
  }

  count(jobId: string): number {
    return this.byJob.get(jobId)?.size ?? 0;
  }
}

/** Tests: `changed(id)` stands in for the database trigger. */
export class MemoryJobWatch implements JobWatch {
  private readonly listening = new Listeners();

  subscribe(jobId: string, onChange: () => void): () => void {
    return this.listening.add(jobId, onChange);
  }

  changed(jobId: string): void {
    this.listening.fire(jobId);
  }

  /** How many streams watch the job (tests check they let go). */
  listeners(jobId: string): number {
    return this.listening.count(jobId);
  }

  async close(): Promise<void> {}
}

/**
 * One dedicated connection LISTENing on `ih_job_changed` for the whole API. A dropped connection
 * is reopened after `retryMs`; every watched job is then re-read, in case it changed meanwhile.
 */
export class PgJobWatch implements JobWatch {
  private readonly listening = new Listeners();
  private client: pg.Client | null = null;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly connectionString: string,
    private readonly log: (err: unknown) => void = () => {},
    private readonly retryMs = 2000,
  ) {
    void this.connect(false);
  }

  subscribe(jobId: string, onChange: () => void): () => void {
    return this.listening.add(jobId, onChange);
  }

  private async connect(reconnected: boolean): Promise<void> {
    if (this.closed) return;
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('notification', (msg) => {
      if (msg.channel === JOB_CHANGED_CHANNEL && msg.payload) this.listening.fire(msg.payload);
    });
    const lost = (err?: unknown) => {
      if (this.client !== client) return;
      this.client = null;
      if (err) this.log(err);
      client.end().catch(() => {});
      this.schedule();
    };
    client.on('error', lost);
    client.on('end', () => lost());
    try {
      await client.connect();
      await client.query(`LISTEN ${JOB_CHANGED_CHANNEL}`);
    } catch (err) {
      this.log(err);
      client.end().catch(() => {});
      this.schedule();
      return;
    }
    if (this.closed) {
      await client.end().catch(() => {});
      return;
    }
    this.client = client;
    if (reconnected) this.listening.fireAll();
  }

  private schedule(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.connect(true);
    }, this.retryMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retry);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => {});
  }
}
