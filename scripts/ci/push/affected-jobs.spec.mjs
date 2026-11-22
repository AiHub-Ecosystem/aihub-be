import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  AREAS,
  CI_JOBS,
  VERIFY_ONLY_CHECKS,
  affectedJobs,
  diffRange,
  planCiJobs,
} from './affected-jobs.mjs';

/**
 * #1796: the detector decides which CI lanes a change can break. These pin the
 * fail-open rule, the areas the issue names, the eight #941 checks, and the
 * workflow wiring that applies the answer.
 */

const BASE = 'e74c84ddd5094275105f12a9e4a4158864aec64b';
const HEAD = '90274f2594596d556cff7e431157db374b722504';
const NULL = '0000000000000000000000000000000000000000';

/** @param {string[]} files */
function plan(files) {
  return affectedJobs(files);
}

await test('a documentation-only change runs the static lane', () => {
  const { jobs, fallback } = plan(['docs/adr/0001-example.md']);
  assert.equal(fallback, undefined);
  assert.deepEqual(
    Object.entries(jobs)
      .filter(([, runs]) => runs)
      .map(([job]) => job),
    ['static'],
  );
});

await test('a source change runs every lane that compiles, tests or boots src', () => {
  const { jobs } = plan(['src/modules/speaking/application/grade.ts']);
  for (const job of [
    'static',
    'test',
    'database',
    'tenant-isolation',
    'build',
    'image',
  ])
    assert.equal(jobs[/** @type {keyof typeof jobs} */ (job)], true, job);
  // The audit lane reads the dependency graph, which a source file cannot change.
  assert.equal(jobs.audit, false);
});

await test('coverage runs only when all three coverage lanes ran', () => {
  assert.equal(
    plan(['src/modules/speaking/application/grade.ts']).jobs.coverage,
    true,
  );

  // A docs change selects no coverage lane, so the merge has nothing to read.
  assert.equal(plan(['docs/adr/0001-example.md']).jobs.coverage, false);

  // The prisma lane and the modules lane together still miss tenant-isolation.
  const partial = plan(['test/db/shared/database.ts']);
  assert.equal(partial.jobs.coverage, true);
  assert.equal(
    plan(['src/modules/speaking/application/grade.ts']).jobs[
      'tenant-isolation'
    ],
    true,
  );
});

await test('the areas the issue names each have a row', () => {
  const areas = AREAS.map(({ area }) => area).join(' | ');
  for (const expected of [
    'src/contracts and src/catalog',
    'src/modules',
    'prisma/migrations',
    'scripts',
    'the deploy manifest',
  ])
    assert.match(areas, new RegExp(expected), expected);
});

await test('every verify-only check from #941 can select the static lane', () => {
  const mapped = new Set(AREAS.flatMap(({ checks }) => checks ?? []));
  for (const check of VERIFY_ONLY_CHECKS)
    assert.ok(mapped.has(check), `${check} is never claimed by a row`);
});

await test('a path no row claims runs every job instead of skipping', () => {
  const { jobs, fallback } = plan(['notes/scratch.txt']);
  assert.ok(fallback, 'an unclassified path must report a fallback');
  for (const job of CI_JOBS) assert.equal(jobs[job], true, job);
});

await test('an empty change set runs every job', () => {
  const { jobs, fallback } = plan([]);
  assert.ok(fallback);
  for (const job of CI_JOBS) assert.equal(jobs[job], true, job);
});

await test('a pull request diffs base..head', () => {
  assert.deepEqual(
    diffRange({ event: 'pull_request', baseSha: BASE, headSha: HEAD }),
    {
      range: `${BASE}..${HEAD}`,
    },
  );
});

await test('a push diffs before..after', () => {
  assert.deepEqual(diffRange({ event: 'push', baseSha: BASE, headSha: HEAD }), {
    range: `${BASE}..${HEAD}`,
  });
});

await test('an unresolvable base fails open', () => {
  for (const baseSha of [NULL, undefined, 'not-a-sha'])
    assert.ok(diffRange({ event: 'push', baseSha, headSha: HEAD }).fallback);
  assert.ok(
    diffRange({ event: 'pull_request', baseSha: BASE, headSha: undefined })
      .fallback,
  );
});

await test('a manual run fails open', () => {
  assert.ok(
    diffRange({ event: 'workflow_dispatch', baseSha: BASE, headSha: HEAD })
      .fallback,
  );
});

await test('a git failure fails open', () => {
  const { jobs, fallback } = planCiJobs({
    event: 'push',
    baseSha: BASE,
    headSha: HEAD,
    git: () => {
      throw new Error('not a git repository');
    },
  });
  assert.match(String(fallback), /not a git repository/);
  for (const job of CI_JOBS) assert.equal(jobs[job], true, job);
});

await test('a push to main never skips the image boot', () => {
  const { jobs } = planCiJobs({
    event: 'push',
    baseSha: BASE,
    headSha: HEAD,
    git: () => 'docs/adr/0001-example.md',
  });
  assert.equal(jobs.image, true);
});

await test('the workflow applies the plan through its outputs', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  assert.match(
    workflow,
    /affected-jobs\.mjs/,
    'the jobs must read the tested plan',
  );

  // Only an exact `false` skips a lane: `==` on the string is the comparison
  // GitHub evaluates, and any other value leaves the job running.
  assert.match(
    workflow,
    /needs\.affected-jobs\.outputs\.[\w-]+ != 'false'/,
    'jobs must skip on exactly false',
  );

  // The required gate is never skipped.
  const gate = workflow.slice(workflow.indexOf('\n  ci:'));
  assert.match(gate, /if: \$\{\{ always\(\) \}\}/);
  // It reads the detector's answer to tell a skipped lane from a failed one,
  // but its own condition is never the detector's output.
  assert.doesNotMatch(
    gate,
    /^ {4}if: .*affected-jobs\.outputs/m,
    'the CI gate must always run',
  );

  // The gate tells a skipped lane from a failed one by reading the detector's
  // answer back, so every lane it checks needs that answer in its environment.
  for (const name of [
    'STATIC',
    'TEST',
    'BUILD',
    'AUDIT',
    'DATABASE',
    'TENANT_ISOLATION',
    'COVERAGE',
    'IMAGE',
  ])
    assert.match(
      gate,
      new RegExp(`AFFECTED_${name}:`),
      `the gate reads AFFECTED_${name} without receiving it`,
    );
});
