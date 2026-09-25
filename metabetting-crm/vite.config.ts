import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served at /metabetting-crm by the reporting app (FastAPI mount, admin login),
// alongside Agency HQ. v1 has no backend at all: every figure lives in the
// browser (localStorage + JSON export), so there is no dev proxy. In dev the
// app lives at http://localhost:5177/metabetting-crm/.
export default defineConfig({
  base: '/metabetting-crm/',
  plugins: [react()],
  server: { port: 5177 },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
