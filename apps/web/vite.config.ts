import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@ih/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // In dev the API runs on :3000; in compose nginx proxies /api to the api service.
    proxy: { '/api': process.env.VITE_API_PROXY ?? 'http://localhost:3000' },
  },
});
