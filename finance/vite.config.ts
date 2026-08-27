import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the static build serves from /finance/ on the hosting
// account. In dev, /api proxies to a local PHP server
// (php -S 127.0.0.1:8941 -t public) so the real endpoints run locally.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      '/api': 'http://127.0.0.1:8941',
    },
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
