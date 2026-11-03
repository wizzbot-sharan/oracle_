import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: webDir,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4100' }
  }
});
