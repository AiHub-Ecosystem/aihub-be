import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  NULL_SHA,
  lintCommitRange,
  planCommitMessageRange,
} from './check-commit-messages.mjs';

const FULL = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

await test('a pull request or a push with a usable range lints exactly that range', () => {
  assert.deepEqual(
    planCommitMessageRange({
      event: 'pull_request',
      baseSha: FULL,
      headSha: OTHER,
    }),
    {
      mode: 'range',
      base: FULL,
      head: OTHER,
    },
  );
  assert.deepEqual(
    planCommitMessageRange({ event: 'push', baseSha: FULL, headSha: OTHER }),
    {
      mode: 'range',
      base: FULL,
      head: OTHER,
    },
  );
});

await test('a range-less trigger is skipped with a reason, never a full-history lint', () => {
  for (const trigger of [
    { event: 'workflow_dispatch', baseSha: FULL, headSha: OTHER },
    // A push that starts the branch (or a force push whose old tip is unknown)
    // carries the null sha as its base.
    { event: 'push', baseSha: NULL_SHA, headSha: OTHER },
    { event: 'push', baseSha: undefined, headSha: OTHER },
    { event: 'pull_request', baseSha: 'not-a-sha', headSha: OTHER },
    { event: 'pull_request', baseSha: OTHER, headSha: OTHER },
  ]) {
    const plan = planCommitMessageRange(trigger);
    assert.equal(plan.mode, 'skipped', JSON.stringify(trigger));
    assert.ok(plan.message.length > 0, JSON.stringify(trigger));
  }
});

await test('every commit in the range is linted through the real hook script', () => {
  /** @type {string[]} */
  const linted = [];
  const result = lintCommitRange({
    plan: { mode: 'range', base: FULL, head: OTHER },
    listCommits: () => ['c1', 'c2', 'c3'],
    lintCommit: (sha) => {
      linted.push(sha);
      return sha === 'c2' ? ['the header must be "type(scope): subject"'] : [];
    },
  });
  assert.deepEqual(linted, ['c1', 'c2', 'c3']);
  assert.equal(result.checked, 3);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /c2/);
  assert.match(result.failures[0], /type\(scope\): subject/);
});

await test('a range with no commits passes without linting anything', () => {
  const result = lintCommitRange({
    plan: { mode: 'range', base: FULL, head: OTHER },
    listCommits: () => [],
    lintCommit: () => {
      throw new Error('must not lint an empty range');
    },
  });
  assert.equal(result.checked, 0);
  assert.deepEqual(result.failures, []);
});

await test('the static job runs the hook suites and the commit range check', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const start = workflow.indexOf('\n  static:');
  const end = workflow.indexOf('\n  test:', start);
  const staticJob = workflow.slice(start, end);
  assert.ok(staticJob.length > 0, 'the static job is missing');
  for (const suite of [
    'bun run test:issue-triage',
    'bun run test:lint-staged',
    'bun run test:doc-drift',
    'bun run test:commit-message',
  ]) {
    assert.ok(staticJob.includes(suite), `the static job must run ${suite}`);
  }
  assert.match(
    staticJob,
    /node scripts\/ci\/commit-messages\/check-commit-messages\.mjs/,
    'the static job must lint the commit messages of the changed range',
  );
});
