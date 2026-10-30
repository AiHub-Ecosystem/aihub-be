import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { transformSync } from '@swc/core';
import { defineConfig } from 'vitest/config';

import { TEST_RUNNER_TARGETS } from './scripts/ops/test-runner-benchmark/targets.mjs';

const root = process.cwd();
const { resolveUnitLaneWorkers } = createRequire(
  resolve(root, 'vitest.config.mts'),
)('./scripts/checks/jest-worker-cap.cjs') as {
  resolveUnitLaneWorkers: () => { maxWorkers: number };
};

export default defineConfig({
  plugins: [
    {
      name: 'aihub-swc-decorator-transform',
      enforce: 'pre' as const,
      transform(source, id) {
        const filename = id.split('?')[0] ?? id;
        if (
          !filename.startsWith(root) ||
          /[\\/]node_modules[\\/]/.test(filename) ||
          !/\.tsx?$/.test(filename)
        ) {
          return null;
        }

        const result = transformSync(source, {
          filename,
          sourceMaps: true,
          jsc: {
            parser: {
              syntax: 'typescript',
              tsx: filename.endsWith('.tsx'),
              decorators: true,
              dynamicImport: true,
            },
            transform: { legacyDecorator: true, decoratorMetadata: true },
            target: 'es2022',
          },
          module: { type: 'es6' },
        });

        return {
          code: result.code,
          map: result.map,
        };
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${resolve(root, 'src')}/` },
      {
        find: /^@prisma-client\//,
        replacement: `${resolve(root, 'dist/generated/prisma')}/`,
      },
    ],
  },
  test: {
    include: TEST_RUNNER_TARGETS,
    environment: 'node',
    globals: true,
    injectCjsGlobals: true,
    maxWorkers: resolveUnitLaneWorkers().maxWorkers,
    testTimeout: 20_000,
    clearMocks: true,
    sequence: { hooks: 'list' },
    setupFiles: [
      './test/runtime-secret-env.ts',
      './test/silence-nest-logger.ts',
      './scripts/ops/test-runner-benchmark/vitest-jest-globals.ts',
      './scripts/ops/test-runner-benchmark/runner-ready.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['json'],
      reportsDirectory: 'coverage/vitest-spike',
      include: ['src/modules/writing/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/testing/**'],
    },
  },
});
