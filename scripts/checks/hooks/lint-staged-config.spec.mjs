import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

await test('pre-commit runs the staged check lane before the staged secret scan', async () => {
  const config = await readFile(
    new URL('../../../.lintstagedrc', import.meta.url),
    'utf8',
  );
  const hook = await readFile(
    new URL('../../../.husky/pre-commit', import.meta.url),
    'utf8',
  );
  const packageJson = await readFile(
    new URL('../../../package.json', import.meta.url),
    'utf8',
  );
  const stagedCheck = hook.indexOf('bun run check:staged');
  const secretScan = hook.indexOf('gitleaks git --staged');

  assert.match(
    config,
    /"\*\.\{ts,mts,cts,js,mjs,cjs\}": \[\s*"bun lint --no-script --no-type-aware --fix"/,
  );
  assert.match(
    config,
    /"\*\.\{md,yaml,yml\}": "prettier --ignore-unknown --write"/,
  );
  assert.match(
    packageJson,
    /"check:staged": "bunx lint-staged --hide-all && bun scripts\/checks\/staged\/check-staged\.mjs"/,
  );
  assert.ok(stagedCheck >= 0 && secretScan > stagedCheck);
  assert.doesNotMatch(hook, /oxlint[^\n]*\s\./);
});

await test('staged type-aware Bun lint profiles reject floating promises in TypeScript and JavaScript', async () => {
  const tempRoot = join(repositoryRoot, 'temp');
  let createdTempRoot = false;
  try {
    await mkdir(tempRoot);
    createdTempRoot = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const fixtureRoot = await mkdtemp(join(tempRoot, 'lint-staged-type-aware-'));
  try {
    const tsconfig = join(fixtureRoot, 'tsconfig.json');
    const typescript = join(fixtureRoot, 'floating-promise.ts');
    const javascript = join(fixtureRoot, 'floating-promise.mjs');
    await Promise.all([
      writeFile(
        tsconfig,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'preserve',
            moduleResolution: 'bundler',
            allowJs: true,
            checkJs: true,
            strict: true,
            noEmit: true,
          },
          include: ['./*.ts', './*.mjs'],
        }),
      ),
      writeFile(typescript, 'Promise.resolve();'),
      writeFile(javascript, 'Promise.resolve();'),
    ]);

    const typeScriptResult = spawnSync(
      'bun',
      [
        'lint',
        '--no-script',
        '--type-aware',
        '--threads=1',
        // Pin one format: Bun otherwise picks it from the environment
        // (`::error` annotations under GITHUB_ACTIONS, another shape under a
        // coding agent), and the match below reads only this one.
        '--format=unix',
        '--tsconfig',
        tsconfig,
        typescript,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const typeScriptOutput = `${typeScriptResult.stdout}\n${typeScriptResult.stderr}`;

    assert.equal(typeScriptResult.error, undefined, typeScriptOutput);
    assert.equal(typeScriptResult.status, 1, typeScriptOutput);
    assert.match(
      typeScriptOutput,
      /floating-promise\.ts:1:1: .*\[Error\/typescript\(no-floating-promises\)\]/,
    );

    const javaScriptResult = spawnSync(
      'bun',
      [
        'lint',
        '--no-script',
        '--type-aware',
        '--threads=1',
        '-A',
        'all',
        '-D',
        'typescript/no-floating-promises',
        '--format=unix',
        javascript,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const javaScriptOutput = `${javaScriptResult.stdout}\n${javaScriptResult.stderr}`;

    assert.equal(javaScriptResult.error, undefined, javaScriptOutput);
    assert.equal(javaScriptResult.status, 1, javaScriptOutput);
    assert.match(
      javaScriptOutput,
      /floating-promise\.mjs:1:1: .*\[Error\/typescript\(no-floating-promises\)\]/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    if (createdTempRoot) {
      await rmdir(tempRoot).catch(() => {});
    }
  }
});

await test('the static job runs this suite in CI (#1786)', async () => {
  const workflow = await readFile(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const start = workflow.indexOf('\n  static:');
  const staticJob = workflow.slice(start, workflow.indexOf('\n  test:', start));
  assert.ok(
    staticJob.includes('bun run test:lint-staged'),
    'the static job must run bun run test:lint-staged',
  );
  assert.ok(
    staticJob.includes('bun run test:check-staged'),
    'the static job must run bun run test:check-staged',
  );
});
