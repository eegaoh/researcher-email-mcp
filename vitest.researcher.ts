import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['src/researcher/**/*.test.ts', 'scripts/publication.test.mjs'], pool: 'threads', testTimeout: 20000 },
});
