import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/ih',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.S3_BUCKET_INBOX).toBe('ingest-inbox');
  });

  it('reports every missing variable at once', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*S3_ENDPOINT/);
  });
});
