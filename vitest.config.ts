import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { preserveSymlinks: true },
  test: {
    server: { deps: { external: ['pptxgenjs'] } },
    include: ['tests/**/*.test.ts', 'apps/figma-plugin/src/**/*.test.tsx'],
  },
});
