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

await test('staged autofix and the full type-aware Oxlint check run in pre-commit', async () => {
  const config = await readFile(
    new URL('../../../.lintstagedrc', import.meta.url),
    'utf8',
  );
  const hook = await readFile(
    new URL('../../../.husky/pre-commit', import.meta.url),
    'utf8',
  );
  const stagedFix = hook.indexOf('GOMAXPROCS=1 bunx lint-staged --hide-all');
  const fullTypeAwareLint = hook.indexOf(
    'GOMAXPROCS=1 bun run oxlint --threads=1 .',
  );

  assert.match(
    config,
    /"\*\.\{ts,mts,cts,js,mjs,cjs\}": \[\s*"oxlint --fix --disable-typescript-plugin"/,
  );
  assert.ok(stagedFix >= 0 && fullTypeAwareLint > stagedFix);
});

await test('type-aware Oxlint rejects floating promises in staged TypeScript and JavaScript', async () => {
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

    const result = spawnSync(
      'bun',
      [
        'run',
        'oxlint',
        '--type-aware',
        '--threads=1',
        '--tsconfig',
        tsconfig,
        typescript,
        javascript,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.error, undefined, output);
    assert.equal(result.status, 1, output);
    assert.match(
      output,
      /floating-promise\.ts:1:1: error typescript\(no-floating-promises\)/,
    );
    assert.match(
      output,
      /floating-promise\.mjs:1:1: error typescript\(no-floating-promises\)/,
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
});
