import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'bridge-contract',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
