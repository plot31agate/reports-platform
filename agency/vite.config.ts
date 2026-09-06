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
  server: { port: 5176 },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
