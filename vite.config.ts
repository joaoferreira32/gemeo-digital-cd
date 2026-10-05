import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the static build works on GitHub Pages sub-paths and on Netlify.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  // Module workers, so the worker can load code on demand (the routing network's
  // runtime is fetched only when the viewer picks it).
  worker: { format: 'es' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
