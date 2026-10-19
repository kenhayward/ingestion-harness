import type pg from 'pg';
import type { PluginInfo } from '@ih/shared';

/**
 * The plugins this deployment's workers can run (`plugin_catalogue`, migration 202610191612),
 * published by the worker at start: recipe checks (`templateIssues`) and the editor read it.
 */
export interface PluginCatalogue {
  /** Every plugin, by ref. */
  list(): Promise<PluginInfo[]>;
}

export class MemoryPluginCatalogue implements PluginCatalogue {
  constructor(private rows: PluginInfo[] = []) {}

  async list(): Promise<PluginInfo[]> {
    return [...this.rows].sort((a, b) => a.ref.localeCompare(b.ref));
  }
}

export class PgPluginCatalogue implements PluginCatalogue {
  constructor(private pool: pg.Pool) {}

  async list(): Promise<PluginInfo[]> {
    const { rows } = await this.pool.query<{
      ref: string;
      plugin_id: string;
      major: number;
      summary: string;
      egress: PluginInfo['egress'];
      settings_schema: Record<string, unknown>;
    }>(
      `SELECT ref, plugin_id, major, summary, egress, settings_schema
         FROM plugin_catalogue ORDER BY ref`,
    );
    return rows.map((r) => ({
      ref: r.ref,
      id: r.plugin_id,
      major: r.major,
      summary: r.summary,
      egress: r.egress,
      settingsSchema: r.settings_schema,
    }));
  }
}
