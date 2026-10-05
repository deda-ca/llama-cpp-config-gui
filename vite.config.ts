import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/client'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Must match the server's PORT (src/server/index.ts defaults to 3000).
      // SSE streams over /api/events, so no separate /ws proxy is needed.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
