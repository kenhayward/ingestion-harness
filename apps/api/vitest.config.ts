import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    // Test against shared source, not its build output.
    alias: {
      '@ih/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@ih/bridge-contract': fileURLToPath(
        new URL('../../packages/bridge-contract/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'api',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    exclude: ['test/integration/**'], // needs dev-infra: npm run test:integration
  },
});
