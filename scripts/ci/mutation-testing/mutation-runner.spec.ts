import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import strykerConfig from '../../../stryker.config.cjs';
import mutationRunner from './mutation-runner.cjs';

const { runMutationTests } = mutationRunner;

const MUTATION_TARGETS = [
  'src/modules/identity/domain/api-key.ts',
  'src/modules/idempotency/application/idempotency-fingerprint.ts',
  'src/common/serialization/canonical-json.ts',
  'src/common/errors/error-code.ts',
  'src/common/errors/error-registry.ts',
  'src/common/security/opaque-token-issuer.ts',
  'src/modules/auth/shared/infrastructure/envelope-cipher.ts',
];

describe('nightly mutation testing', () => {
  it('runs only the six issue-listed modules with Jest and the TypeScript checker', () => {
    const config = strykerConfig as {
      checkers: string[];
      coverageAnalysis: string;
      concurrency: number;
      jest: {
        config: {
          maxWorkers: number;
          testMatch: string[];
          workerIdleMemoryLimit: number | undefined;
        };
        configFile: string;
        enableFindRelatedTests: boolean;
      };
      mutate: string[];
      reporters: string[];
      testRunner: string;
      tempDirName: string;
      thresholds: { break: number | null };
    };
    const workflow = readFileSync(
      resolve('.github/workflows/mutation-testing.yml'),
      'utf8',
    );
    const generateTypesStep = workflow.indexOf(
      'run: bun run generate:prisma-client',
    );
    const mutationStep = workflow.indexOf('name: Run StrykerJS');

    expect(config.mutate).toEqual(MUTATION_TARGETS);
    expect(config.testRunner).toBe('jest');
    expect(config.jest).toMatchObject({
      configFile: 'jest.config.cjs',
      enableFindRelatedTests: true,
      config: {
        maxWorkers: 1,
        workerIdleMemoryLimit: undefined,
        testMatch: [
          '**/src/**/*.spec.ts',
          '**/test/**/*.spec.ts',
          '**/scripts/**/*.spec.ts',
        ],
      },
    });
    expect(config.checkers).toContain('typescript');
    expect(config.coverageAnalysis).toBe('off');
    expect(config.concurrency).toBe(4);
    expect(config.tempDirName).toBe('temp/stryker-mutation');
    expect(config.reporters).toEqual(expect.arrayContaining(['html', 'json']));
    expect(config.thresholds.break).toBe(95);
    expect(mutationStep).toBeGreaterThanOrEqual(0);
    expect(generateTypesStep).toBeGreaterThanOrEqual(0);
    expect(generateTypesStep).toBeLessThan(mutationStep);
    expect(workflow).toMatch(/^  schedule:/m);
    expect(workflow).not.toMatch(/^  pull_request:/m);
  });

  it('preserves the report without applying a second score gate', () => {
    const tempRoot = resolve('temp');
    const outputDir = join(tempRoot, `mutation-runner-${randomUUID()}`);
    const report = {
      mutationScore: 0,
      files: {
        [MUTATION_TARGETS[0]!]: {
          mutationScore: 0,
          mutants: [{ status: 'Survived' }],
        },
      },
    };
    let command: string | undefined;
    let args: string[] | undefined;
    let configuredOutputDir: string | undefined;

    mkdirSync(outputDir, { recursive: true });
    try {
      const exitCode = runMutationTests({
        outputDir,
        execute: (invocation) => {
          command = invocation.command;
          args = invocation.args;
          configuredOutputDir = invocation.env['AIHUB_MUTATION_OUTPUT_DIR'];
          writeFileSync(
            join(outputDir, 'mutation.json'),
            `${JSON.stringify(report)}\n`,
          );
          return { status: 0 };
        },
      });

      expect(command).toBe('bun');
      expect(args).toEqual(['run', 'stryker', 'run']);
      expect(configuredOutputDir).toBe(outputDir);
      expect(exitCode).toBe(0);
      expect(existsSync(join(outputDir, 'mutation.json'))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(outputDir, 'mutation.json'), 'utf8')),
      ).toEqual(report);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
      if (readdirSync(tempRoot).length === 0) {
        rmdirSync(tempRoot);
      }
    }
  });
});
