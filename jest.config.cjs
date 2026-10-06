/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  maxWorkers: 2,
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
  clearMocks: true,
};
