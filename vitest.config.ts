import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    environment: 'node',
    include: ['test/**/*.spec.ts', 'test/**/*.e2e-spec.ts', 'src/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
    // Sequential execution prevents parallel tests from clobbering shared
    // PostgreSQL tables and Redis state. In Vitest 4, poolOptions was removed;
    // use the top-level singleThread option (threads pool) or fileParallelism: false.
    pool: 'threads',
    singleThread: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/shared/otel/otel.ts',
        'src/main.api.ts',
        'src/main.worker.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
      },
    },
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: {
          syntax: 'typescript',
          decorators: true,
        },
        transform: {
          decoratorMetadata: true,
        },
        target: 'es2022',
      },
    }),
  ],
});
