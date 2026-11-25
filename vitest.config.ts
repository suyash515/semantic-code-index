import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'], testTimeout: 20_000 } },
      { test: { name: 'integration', include: ['test/integration/**/*.test.ts'], testTimeout: 60_000 } },
      { test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], testTimeout: 180_000, fileParallelism: false } },
      { test: { name: 'model', include: ['test/model/**/*.test.ts'], testTimeout: 600_000, fileParallelism: false } }
    ]
  }
});
