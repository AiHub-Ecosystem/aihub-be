const base = require('./jest.config.db.cjs');

if (!process.env.DB_LANE_DATABASE_NAME?.trim()) {
  process.env.DB_LANE_DATABASE_NAME = 'aihub_tenant_isolation_lane';
}

module.exports = {
  ...base,
  testMatch: ['<rootDir>/test/db/tenant-isolation/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
};
