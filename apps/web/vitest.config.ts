import { defineProject, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  defineProject({
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['test/**/*.test.{ts,tsx}'],
      setupFiles: ['test/setup.ts'],
    },
  }),
);
