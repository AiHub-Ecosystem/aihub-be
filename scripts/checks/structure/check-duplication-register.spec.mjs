import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  findClosedOwnerIssueNumbers,
  findManualNoStoreHeaders,
} from './check-duplication-register.mjs';

await test('reports closed owner issues but ignores solved history', () => {
  const register = [
    '| E1 | cache headers | open — owner: #1341 |',
    '| E2 | old work | solved — owner: #1408 |',
    '| E3 | current work | owner: #1781 |',
  ].join('\n');

  assert.deepEqual(
    findClosedOwnerIssueNumbers(
      register,
      new Map([
        [1341, 'CLOSED'],
        [1781, 'OPEN'],
      ]),
    ),
    [1341],
  );
});

await test('finds a reintroduced manual no-store header in a route file', () => {
  assert.deepEqual(
    findManualNoStoreHeaders([
      {
        path: 'speaking.controller.ts',
        content: "reply.header('Cache-Control', 'no-store');\n",
      },
    ]),
    ['speaking.controller.ts:1'],
  );
});

await test('Speaking grading-job responses rely on the route catalog hook', () => {
  const source = readFileSync(
    'src/modules/speaking/presentation/speaking-grading-jobs.controller.ts',
    'utf8',
  );
  const spec = readFileSync(
    'src/modules/speaking/presentation/speaking-grading-jobs.controller.spec.ts',
    'utf8',
  );

  assert.deepEqual(
    findManualNoStoreHeaders([
      { path: 'speaking-grading-jobs.controller.ts', content: source },
    ]),
    [],
  );
  assert.equal(
    (spec.match(/headers\['cache-control'\]\)\.toBe\('no-store'\)/gu) ?? [])
      .length >= 2,
    true,
  );
});
