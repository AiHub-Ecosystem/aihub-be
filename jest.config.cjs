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
  collectCoverageFrom: ['<rootDir>/src/**/*.ts'],
  clearMocks: true,
};
