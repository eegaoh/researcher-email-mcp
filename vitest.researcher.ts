import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['src/researcher/**/*.test.ts'], pool: 'threads', testTimeout: 20000 },
});
