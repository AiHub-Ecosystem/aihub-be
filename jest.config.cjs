/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  setupFiles: ['<rootDir>/test/runtime-secret-env.ts'],
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
  collectCoverageFrom: ['<rootDir>/src/**/*.ts'],
  clearMocks: true,
};
