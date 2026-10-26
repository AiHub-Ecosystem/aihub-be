import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

await test('type-aware Oxlint runs from the repository root for staged source', async () => {
  const config = await readFile(
    new URL('../../.lintstagedrc', import.meta.url),
    'utf8',
  );
  const hook = await readFile(
    new URL('../../.husky/pre-commit', import.meta.url),
    'utf8',
  );
  const taskStart = config.indexOf('"*.{ts,mts,cts,js,mjs,cjs}"');
  const taskEnd = config.indexOf('],', taskStart);

  assert.ok(taskStart >= 0 && taskEnd > taskStart);
  assert.ok(config.slice(taskStart, taskEnd).includes('"oxlint --fix ."'));
  assert.ok(hook.includes('lint-staged --hide-all'));
});
