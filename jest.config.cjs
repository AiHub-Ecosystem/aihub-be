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
  // alternatives cover pnpm's store path and the linked path (ADR-0047).
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
