import { defineConfig } from 'vitest/config';

// Root runner: each workspace owns its own vitest.config.ts (environment, aliases).
export default defineConfig({
  test: {
    projects: [
      'packages/shared/vitest.config.ts',
      'apps/api/vitest.config.ts',
      'apps/web/vitest.config.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
    },
  },
});
