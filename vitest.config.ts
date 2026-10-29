import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // v2.47.0 (audit phase 0) → v2.58.1 (round 86, audit F9): every run
    // executes against isolated copies of the database, never the real
    // dev.db.
    // v2.58.4 (external audit F09): runs are isolated from EACH OTHER as
    // well — a unique run id (BGL_TEST_RUN_ID) names every file under
    // prisma/.test-runs/, the default template source is a SYNTHETIC
    // fixture (migrations + seed, zero contact with dev.db; opt in to
    // the real-data snapshot with BGL_TEST_DB_SOURCE=dev), and cleanup
    // (the named `teardown` export of the same file) removes only this
    // run's own files. Two concurrent vitest runs cannot see or delete
    // each other's data.
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
