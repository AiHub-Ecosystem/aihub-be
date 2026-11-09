import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  GENERATED_ARTIFACTS,
  findGeneratedDrift,
} from './check-generated-drift.mjs';

await test('every generated artifact names the command that regenerates it and the paths it owns', () => {
  assert.deepEqual(
    GENERATED_ARTIFACTS.map((artifact) => artifact.name),
    [
      'OpenAPI document and majors',
      'Postman collection',
      'Transactional email template',
    ],
  );
  assert.deepEqual(GENERATED_ARTIFACTS[0].command, [
    'bun',
    ['run', 'generate:openapi'],
  ]);
  assert.deepEqual(GENERATED_ARTIFACTS[1].command, [
    'bun',
    ['run', 'generate:postman'],
  ]);
  assert.deepEqual(GENERATED_ARTIFACTS[2].command, [
    'node',
    ['scripts/generate/compile-auth-email-template.mjs'],
  ]);
  assert.deepEqual(GENERATED_ARTIFACTS[0].paths, ['openapi.json', 'openapi']);
  assert.deepEqual(GENERATED_ARTIFACTS[1].paths, [
    'aihub.postman_collection.json',
  ]);
  assert.deepEqual(GENERATED_ARTIFACTS[2].paths, [
    'src/modules/auth/email-delivery/application/templates/transactional-email.template.generated.ts',
  ]);
  for (const artifact of GENERATED_ARTIFACTS) {
    for (const path of artifact.paths) {
      assert.ok(
        existsSync(path),
        `generated artifact is not committed: ${path}`,
      );
    }
  }
});

await test('a clean tree after every regeneration reports no drift', () => {
  /** @type {string[][]} */
  const ran = [];
  const { drifted, failedGenerators } = findGeneratedDrift({
    run: (file, args) => {
      ran.push([file, ...args]);
      return { code: 0 };
    },
    status: () => [],
  });
  assert.deepEqual(drifted, []);
  assert.deepEqual(failedGenerators, []);
  assert.equal(ran.length, GENERATED_ARTIFACTS.length);
});

await test('a dirty path after regeneration is reported under its artifact', () => {
  const calls = [];
  const { drifted, failedGenerators } = findGeneratedDrift({
    run: (file, args) => {
      calls.push([file, ...args]);
      return { code: 0 };
    },
    status: (paths) =>
      paths.includes('openapi.json') ? [' M openapi.json'] : [],
  });
  assert.deepEqual(failedGenerators, []);
  assert.equal(drifted.length, 1);
  assert.match(drifted[0], /OpenAPI document and majors/);
  assert.match(drifted[0], /openapi\.json/);
  assert.equal(calls.length, GENERATED_ARTIFACTS.length);
});

await test('a failed generator is reported instead of silently passing its artifact', () => {
  const { drifted, failedGenerators } = findGeneratedDrift({
    run: (file) => (file === 'bun' ? { code: 1 } : { code: 0 }),
    status: () => [],
  });
  assert.deepEqual(drifted, []);
  assert.deepEqual(failedGenerators, [
    'OpenAPI document and majors',
    'Postman collection',
  ]);
});

await test('the static job runs the check on pull requests and pushes to main', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const staticJob = workflow.slice(
    workflow.indexOf('  static:'),
    workflow.indexOf('  oasdiff'),
  );
  assert.ok(staticJob.length > 0, 'the static job is missing');
  assert.match(
    staticJob,
    /node scripts\/ci\/generated-drift\/check-generated-drift\.mjs/,
    'the static job must run the generated-artifact drift check',
  );
});
