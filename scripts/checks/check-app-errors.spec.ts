import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { findViolations } from './check-app-errors';

const ROOT = process.cwd();
const TEMP_ROOT = path.join(ROOT, 'temp');

void test('raw runtime Error throws fail while explicitly allowed builders pass', async () => {
  await mkdir(TEMP_ROOT, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(TEMP_ROOT, 'check-app-errors-'));

  try {
    const sourceRoot = path.join(fixtureRoot, 'src');
    await mkdir(path.join(sourceRoot, 'openapi'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'common', 'errors'), {
      recursive: true,
    });
    await writeFile(
      path.join(sourceRoot, 'runtime.ts'),
      "export function fail() { throw new Error('raw'); const marker = '// app-error-check: allow a string is not a comment'; }\n",
    );
    await writeFile(
      path.join(sourceRoot, 'openapi', 'openapi-shared.ts'),
      "export function build() { throw new Error('builder'); }\n",
    );
    await writeFile(
      path.join(sourceRoot, 'common', 'errors', 'error-registry.ts'),
      "throw new Error('invalid code'); // app-error-check: allow no AppError code is valid here.\n",
    );

    assert.deepEqual(await findViolations(fixtureRoot), ['src/runtime.ts:1']);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    if ((await readdir(TEMP_ROOT)).length === 0) {
      await rm(TEMP_ROOT, { recursive: true, force: true });
    }
  }
});

void test('the current runtime source has no unapproved raw Error throws', async () => {
  assert.deepEqual(await findViolations(), []);
});

void test('inline allow markers require a written reason', async () => {
  const source = await readFile(
    path.join(ROOT, 'src/common/errors/error-registry.ts'),
    'utf8',
  );
  assert.match(source, /app-error-check: allow .+/u);
});
