import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { demoPlugin } from './src/v2/demo-plugin';

export default defineConfig({
  // demoPlugin is structurally a Vite plugin. Cast because Vitest bundles its own Vite types.
  plugins: [react(), demoPlugin() as never],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3847',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
