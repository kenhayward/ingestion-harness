import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    // Test against the contract's source, not its build output.
    alias: {
      '@ih/bridge-contract': fileURLToPath(
        new URL('../../packages/bridge-contract/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'bridge',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'], // needs Postgres: npm run test:integration
  },
});
