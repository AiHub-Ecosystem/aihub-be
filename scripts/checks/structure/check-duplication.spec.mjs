import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const JSCPD = join(ROOT, 'node_modules/jscpd/run-jscpd.js');
const TEMP_ROOT = join(ROOT, 'temp');

const CLONE = `export function prepareEntries(entries: readonly string[], maximumLength: number): string[] {
  const prepared: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    const normalizedWhitespace = trimmed.replace(/\\s+/gu, ' ');
    const normalizedCase = normalizedWhitespace.toLowerCase();
    const normalizedCharacters = Array.from(normalizedCase);
    const exceedsMaximum = normalizedCharacters.length > maximumLength;
    const isEmpty = normalizedCharacters.length === 0;
    const hasOnlyAllowedCharacters = /^[a-z0-9 _-]+$/u.test(normalizedCase);
    if (isEmpty || exceedsMaximum || !hasOnlyAllowedCharacters) continue;
    prepared.push(normalizedCase);
  }
  return prepared;
}`;
const SOURCE_ONLY = `export const sourceOnlyValues = [\n${Array.from(
  { length: 45 },
  (_, index) => `  'source-${index}-value'`,
).join(',\n')}\n].map((entry) => entry.toUpperCase());`;
const COPY_ONLY = `export const copyOnlyValues = [\n${Array.from(
  { length: 45 },
  (_, index) => `  'copy-${index}-value'`,
).join(',\n')}\n].map((entry) => entry.toLowerCase());`;

await test('pins the active inventory thresholds and exclusions', () => {
  assert.deepEqual(
    JSON.parse(readFileSync(join(ROOT, '.jscpd.json'), 'utf8')),
    {
      minLines: 8,
      minTokens: 80,
      ignore: ['**/fixtures/**', '**/generated/**'],
      failOnEmpty: true,
    },
  );
});

await test('fails on a new clone and passes a deliberate registered clone without a baseline edit', () => {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const fixture = mkdtempSync(join(TEMP_ROOT, 'duplication-gate-'));
  const sourceDirectory = join(fixture, 'src');
  const sourcePath = join(sourceDirectory, 'source.ts');
  const copyPath = join(sourceDirectory, 'copy.ts');
  const registerPath = join(fixture, 'docs/agents/duplication-register.md');

  try {
    mkdirSync(sourceDirectory, { recursive: true });
    mkdirSync(join(fixture, 'docs/agents'), { recursive: true });
    writeFileSync(sourcePath, `${CLONE}\n${SOURCE_ONLY}\n`);
    writeFileSync(
      join(fixture, '.jscpd.json'),
      readFileSync(join(ROOT, '.jscpd.json'), 'utf8'),
    );
    writeFileSync(registerPath, '# Duplication register\n');
    execFileSync('git', ['init', '--initial-branch=main'], {
      cwd: fixture,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Duplication test'], {
      cwd: fixture,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      ['config', 'user.email', 'duplication-test@example.invalid'],
      {
        cwd: fixture,
        stdio: 'ignore',
      },
    );
    execFileSync('git', ['config', 'core.hooksPath', join(fixture, 'hooks')], {
      cwd: fixture,
      stdio: 'ignore',
    });
    mkdirSync(join(fixture, 'hooks'));
    execFileSync('git', ['add', '.jscpd.json', 'docs', 'src'], {
      cwd: fixture,
      stdio: 'ignore',
    });
    execFileSync('git', ['commit', '-m', 'base'], {
      cwd: fixture,
      stdio: 'ignore',
    });

    const runGate = () =>
      spawnSync(
        process.execPath,
        [
          JSCPD,
          'src',
          '--config',
          '.jscpd.json',
          '--baseline-from-ref',
          'main',
          '--fail-on-new-clones',
          '0',
          '--reporters',
          'silent',
        ],
        { cwd: fixture, encoding: 'utf8' },
      );

    const baselineRun = runGate();
    assert.equal(
      baselineRun.status,
      0,
      `the baseline tree should pass\n${baselineRun.stdout}\n${baselineRun.stderr}`,
    );

    mkdirSync(join(sourceDirectory, 'fixtures'), { recursive: true });
    mkdirSync(join(sourceDirectory, 'generated'), { recursive: true });
    writeFileSync(join(sourceDirectory, 'fixtures/ignored.ts'), `${CLONE}\n`);
    writeFileSync(join(sourceDirectory, 'generated/ignored.ts'), `${CLONE}\n`);
    const excludedFilesRun = runGate();
    assert.equal(
      excludedFilesRun.status,
      0,
      `fixture and generated clones should be excluded\n${excludedFilesRun.stdout}\n${excludedFilesRun.stderr}`,
    );

    writeFileSync(copyPath, `${CLONE}\n`);
    const newCloneRun = runGate();
    assert.equal(
      newCloneRun.status,
      1,
      `an undocumented new clone should fail\n${newCloneRun.stdout}\n${newCloneRun.stderr}`,
    );

    writeFileSync(
      registerPath,
      '# Duplication register\n\n| Test row | src/source.ts and src/copy.ts | deliberate platform mirror |\n',
    );
    const registeredBlock = `// jscpd:ignore-start\n${CLONE}\n// jscpd:ignore-end`;
    writeFileSync(sourcePath, `${registeredBlock}\n${SOURCE_ONLY}\n`);
    writeFileSync(copyPath, `${registeredBlock}\n${COPY_ONLY}\n`);
    const registeredCloneRun = runGate();
    assert.equal(
      registeredCloneRun.status,
      0,
      `a registered intentional clone wrapped in ignore markers should pass\n${registeredCloneRun.stdout}\n${registeredCloneRun.stderr}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
