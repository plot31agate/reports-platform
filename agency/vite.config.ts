import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served at /agency by the reporting app (FastAPI mount), so the base is the
// absolute /agency/ — asset and data URLs then resolve correctly whether or not
// the visitor's URL has a trailing slash. In dev the app therefore lives at
// http://localhost:5176/agency/. public/snapshot.json covers dev; in production
// the app's /agency/snapshot.json route serves live data from reporting.db.
export default defineConfig({
  base: '/agency/',
  plugins: [react()],
  server: {
    port: 5176,
    // In dev the SPA is served by Vite but its data + write API live on the
    // FastAPI app (reporting core). Proxy just those paths through so the app
    // talks to the real reporting.db; everything else is served by Vite.
    // When the backend isn't running the proxy simply fails and the app falls
    // back to public/snapshot.json + the localStorage overlay.
    proxy: {
      '/agency/api': { target: 'http://127.0.0.1:8001', changeOrigin: true },
      '/agency/snapshot.json': { target: 'http://127.0.0.1:8001', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
