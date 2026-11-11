const outputDir =
  process.env.AIHUB_MUTATION_OUTPUT_DIR ?? 'temp/mutation-testing';

module.exports = {
  mutate: [
    'src/modules/identity/domain/api-key.ts',
    'src/modules/idempotency/application/idempotency-fingerprint.ts',
    'src/common/serialization/canonical-json.ts',
    'src/common/errors/error-code.ts',
    'src/common/errors/error-registry.ts',
    'src/common/security/opaque-token-issuer.ts',
    'src/modules/auth/shared/infrastructure/envelope-cipher.ts',
  ],
  testRunner: 'jest',
  jest: {
    projectType: 'custom',
    configFile: 'jest.config.cjs',
    config: {
      maxWorkers: 1,
      workerIdleMemoryLimit: undefined,
      testMatch: [
        '**/src/**/*.spec.ts',
        '**/test/**/*.spec.ts',
        '**/scripts/**/*.spec.ts',
      ],
    },
    enableFindRelatedTests: true,
  },
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  coverageAnalysis: 'off',
  tempDirName: 'temp/stryker-mutation',
  cleanTempDir: 'always',
  reporters: ['progress', 'clear-text', 'html', 'json'],
  htmlReporter: { fileName: `${outputDir}/mutation.html` },
  jsonReporter: { fileName: `${outputDir}/mutation.json` },
  concurrency: 4,
  thresholds: { high: 80, low: 60, break: 95 },
};
