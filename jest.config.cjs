const {
  DEFAULT_MAX_WORKERS,
  REQUEST_VARIABLE,
  resolveUnitLaneWorkers,
} = require('./scripts/checks/jest-worker-cap.cjs');

const unitLane = resolveUnitLaneWorkers({});
if (unitLane.capped) {
  // A slower lane on a tight machine must not read as a hung test run.
  console.warn(
    `jest: unit lane capped to ${unitLane.maxWorkers} worker (normally ${DEFAULT_MAX_WORKERS}) because free memory is below its budget. Pin a count with ${REQUEST_VARIABLE} to silence this.`,
  );
}

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  maxWorkers: unitLane.maxWorkers,
  // The cap above decides how many workers may start; this decides how far one
  // of them may grow before Jest recycles it between suites. The 2026-10-20 lane
  // death was heap accumulated across suites inside long-lived workers, not one
  // suite's own footprint, so recycling is the matching remedy. One gibibyte
  // keeps a permitted worker inside the two-gigabyte start budget the cap uses.
  // Measured 2026-10-21 on this repository, two workers: no cost — 26 suites
  // 8,1 s against 8,2 s without it, and one focused suite 4,7 s against 5,6 s.
  // It has no effect when the cap leaves one worker, because Jest then runs the
  // lane in the main process.
  workerIdleMemoryLimit: 1024 ** 3,
  rootDir: '.',
  setupFiles: [
    '<rootDir>/test/runtime-secret-env.ts',
    '<rootDir>/test/silence-nest-logger.ts',
  ],
  transform: {
    '^.+\\.(t|j)s?$': ['@swc/jest'],
  },
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/test/**/*.spec.ts',
    '<rootDir>/scripts/**/*.spec.ts',
  ],
  // The database lane has its own config and needs a live PostgreSQL; this
  // lane must keep running with none.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/db/'],
  // NestJS 12 and @nestjs/config ship ESM packages. Node loads them through
  // own module loader does not, so SWC compiles it to CommonJS here. The two
  // alternatives cover the `.pnpm` store path and the linked path (ADR-0047);
  // Bun's flat `node_modules` matches the plain package names.
  transformIgnorePatterns: [
    '/node_modules/(?!\\.pnpm/@nestjs\\+|\\.pnpm/@fastify\\+|\\.pnpm/jose|@nestjs/|@fastify/|jose/|.pnpm/cookie|cookie/)',
  ],
  collectCoverageFrom: ['<rootDir>/src/**/*.ts'],
  // Freeze today's measured coverage as the floor so a regression in the unit
  // lane fails instead of silently shipping (issue #812). Thresholds sit
  // marginally below the measured lines/branches to absorb tooling noise;
  // ratchet upward in follow-ups.
  coverageThreshold: {
    global: {
      lines: 83,
      branches: 72,
    },
  },
  clearMocks: true,
};
