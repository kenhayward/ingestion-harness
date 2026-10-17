import type pg from 'pg';
import type { MaintenanceBody, MaintenanceView } from '@ih/shared';

/** Maintenance mode (migration 0046): one row, read on every guarded request (cached briefly). */
export interface MaintenanceRepo {
  get(): Promise<MaintenanceView>;
  /** Saves it; `since` is set when it goes on, kept while it stays on, cleared when off. */
  set(next: MaintenanceBody, by: string | null): Promise<MaintenanceView>;
}

const OFF: MaintenanceView = {
  enabled: false,
  message: '',
  since: null,
  updatedBy: null,
  updatedAt: null,
};

export class MemoryMaintenanceRepo implements MaintenanceRepo {
  private view: MaintenanceView = OFF;

  async get(): Promise<MaintenanceView> {
    return this.view;
  }

  async set(next: MaintenanceBody, by: string | null): Promise<MaintenanceView> {
    const now = new Date().toISOString();
    this.view = {
      enabled: next.enabled,
      message: next.message,
      since: next.enabled ? (this.view.since ?? now) : null,
      updatedBy: by,
      updatedAt: now,
    };
    return this.view;
  }
}

interface Row {
  enabled: boolean;
  message: string;
  since: Date | null;
  updated_by: string | null;
  updated_at: Date | null;
}

const toView = (r: Row): MaintenanceView => ({
  enabled: r.enabled,
  message: r.message,
  since: r.since?.toISOString() ?? null,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at?.toISOString() ?? null,
});

export class PgMaintenanceRepo implements MaintenanceRepo {
  constructor(private readonly pool: pg.Pool) {}

  async get(): Promise<MaintenanceView> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM maintenance');
    return rows[0] ? toView(rows[0]) : OFF;
  }

  async set(next: MaintenanceBody, by: string | null): Promise<MaintenanceView> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO maintenance (id, enabled, message, since, updated_by, updated_at)
       VALUES (true, $1, $2, CASE WHEN $1 THEN now() END, $3, now())
       ON CONFLICT (id) DO UPDATE SET enabled = $1, message = $2,
         since = CASE WHEN NOT $1 THEN NULL ELSE coalesce(maintenance.since, now()) END,
         updated_by = $3, updated_at = now()
       RETURNING *`,
      [next.enabled, next.message, by],
    );
    return toView(rows[0]!);
  }
}

/**
 * The state the access hook checks on every request, cached for `ttlMs` so a busy API reads the
 * row a few times a minute, not per request. A save through this API refreshes it at once; other
 * API instances see the change within `ttlMs`.
 */
export class MaintenanceGate {
  private cached: { view: MaintenanceView; at: number } | null = null;
  /** Set by a restore: wins over the row (which the restore is replacing) until released. */
  private forced: MaintenanceView | null = null;

  constructor(
    private readonly repo: MaintenanceRepo,
    private readonly ttlMs = 5000,
  ) {}

  /** Holds maintenance on in this process whatever the row says, until `release`. */
  force(view: MaintenanceView): void {
    this.forced = view;
  }

  /** Back to the row, read afresh (a restore has just swapped the database under it). */
  release(): void {
    this.forced = null;
    this.cached = null;
  }

  async current(): Promise<MaintenanceView> {
    if (this.forced) return this.forced;
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.view;
    const view = await this.repo.get();
    this.cached = { view, at: Date.now() };
    return view;
  }

  async set(next: MaintenanceBody, by: string | null): Promise<MaintenanceView> {
    const view = await this.repo.set(next, by);
    this.cached = { view, at: Date.now() };
    return view;
  }
}
