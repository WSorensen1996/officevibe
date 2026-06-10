import { defineConfig } from 'vitest/config';

// Node-environment unit tests for the security-sensitive, electron-free modules
// (path confinement + the approval-gate risk heuristic). Anything importing
// `electron` at module load is out of scope here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
});
