/**
 * The database-backed lane. Kept separate from the default unit-test config so
 * the fast lane stays fast and still runs with no database present.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  setupFiles: [
    '<rootDir>/test/runtime-secret-env.ts',
    '<rootDir>/test/silence-nest-logger.ts',
  ],
  globalSetup: '<rootDir>/test/db/global-setup.ts',
  transform: {
    '^.+.(t|j)s?$': ['@swc/jest'],
  },
  testMatch: ['<rootDir>/test/db/**/*.spec.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/test/db/tenant-isolation/',
  ],
  // Same reason as the unit lane: NestJS 12 is ESM only (ADR-0047).
  transformIgnorePatterns: [
    '/node_modules/(?!\\.pnpm/@nestjs\\+|\\.pnpm/@fastify\\+|\\.pnpm/jose|@nestjs/|@fastify/|jose/|.pnpm/cookie|cookie/)',
  ],
  testTimeout: 30_000,
  clearMocks: true,
};
