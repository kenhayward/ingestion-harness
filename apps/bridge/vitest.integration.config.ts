import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests need a throwaway Postgres (IH_TEST_DATABASE_URL): `npm run test:integration`.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@ih/bridge-contract': fileURLToPath(
        new URL('../../packages/bridge-contract/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'bridge-integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
