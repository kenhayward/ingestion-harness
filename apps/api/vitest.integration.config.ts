import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests need dev-infra (Postgres + SeaweedFS): `npm run test:integration`.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@ih/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'api-integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
