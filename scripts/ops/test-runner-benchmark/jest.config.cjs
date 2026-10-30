const base = require('../../../jest.config.cjs');
const path = require('node:path');

module.exports = {
  ...base,
  rootDir: path.resolve(__dirname, '../../..'),
  testTimeout: 20_000,
  setupFilesAfterEnv: [
    '<rootDir>/scripts/ops/test-runner-benchmark/runner-ready.ts',
  ],
  collectCoverageFrom: [
    '<rootDir>/src/modules/writing/**/*.ts',
    '!<rootDir>/src/modules/writing/**/*.spec.ts',
    '!<rootDir>/src/modules/writing/**/testing/**/*.ts',
  ],
  coverageThreshold: { global: { lines: 0, branches: 0 } },
};
