const databaseConfig = require('./jest.config.db.cjs');
delete databaseConfig.globalSetup;
delete databaseConfig.globalTeardown;

module.exports = {
  ...databaseConfig,
  testMatch: ['<rootDir>/test/db/dispatch-attempt-crash.worker.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 60_000,
};
