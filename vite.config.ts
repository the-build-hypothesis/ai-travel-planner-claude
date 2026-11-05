import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist/client', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } } },
});
