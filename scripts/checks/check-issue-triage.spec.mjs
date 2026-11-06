import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findViolations,
  parseOpenIssues,
  parseTarget,
  parseTrackerPages,
  trackerQuery,
} from './check-issue-triage.mjs';

/**
 * @param {{labels?: string[], milestone?: {id: number, title: string} | null, pull_request?: object}} [options]
 */
function issue({
  labels = [],
  milestone = { id: 1, title: 'M' },
  pull_request,
} = {}) {
  const out = {
    number: 1,
    title: 't',
    labels: labels.map((name) => ({ name })),
  };
  if (milestone) out.milestone = milestone;
  if (pull_request) out.pull_request = pull_request;
  return out;
}

await test('well-formed ready issue passes', () => {
  assert.deepEqual(
    findViolations([issue({ labels: ['ready-for-agent', 'P2'] })]),
    [],
  );
});

await test('parses GitHub open issues and rejects malformed label data', () => {
  assert.deepEqual(
    parseOpenIssues('[{"number":1,"title":"t","labels":[{"name":"P1"}]}]'),
    [{ number: 1, title: 't', labels: [{ name: 'P1' }] }],
  );
  assert.throws(
    () => parseOpenIssues('[{"number":1,"title":"t","labels":[null]}]'),
    /invalid issue/,
  );
});

await test('missing milestone is flagged', () => {
  const v = findViolations([
    issue({ labels: ['ready-for-agent', 'P2'], milestone: null }),
  ]);
  assert.equal(v.length, 1);
  assert.ok(v[0].reasons.some((r) => r.includes('no milestone')));
});

await test('no triage role is flagged', () => {
  const v = findViolations([issue({ labels: ['P1'] })]);
  assert.ok(v[0].reasons.some((r) => r.includes('no triage role')));
});

await test('multiple roles are flagged', () => {
  const v = findViolations([
    issue({ labels: ['ready-for-agent', 'needs-triage', 'P1'] }),
  ]);
  assert.ok(v[0].reasons.some((r) => r.includes('multiple triage roles')));
});

await test('multiple priorities are flagged', () => {
  const v = findViolations([
    issue({ labels: ['ready-for-agent', 'P1', 'P2'] }),
  ]);
  assert.ok(v[0].reasons.some((r) => r.includes('multiple priority labels')));
});

await test('ready-for-* without a priority is flagged', () => {
  const v = findViolations([issue({ labels: ['ready-for-human'] })]);
  assert.ok(v[0].reasons.some((r) => r.includes('without a priority')));
});

await test('needs-triage without a priority is allowed (not yet prioritised)', () => {
  assert.deepEqual(findViolations([issue({ labels: ['needs-triage'] })]), []);
});

await test('needs-info without a priority is allowed', () => {
  assert.deepEqual(findViolations([issue({ labels: ['needs-info'] })]), []);
});

await test('pull requests are skipped', () => {
  assert.deepEqual(
    findViolations([issue({ pull_request: {}, labels: [] })]),
    [],
  );
});

await test('reads a --target issue number', () => {
  assert.equal(parseTarget(['--target', '1613']), 1613);
  assert.equal(parseTarget([]), undefined);
  assert.throws(() => parseTarget(['--target', '0']), /positive issue number/);
});

await test('queries only the four fields the audit reads', () => {
  assert.match(trackerQuery, /number/);
  assert.match(trackerQuery, /title/);
  assert.match(trackerQuery, /labels\(first:100\)\{nodes\{name\}\}/);
  assert.match(trackerQuery, /milestone\{number\}/);
  assert.doesNotMatch(
    trackerQuery,
    /\bbody\b|\bcomments\b|\buser\b|\bauthor\b/,
  );
  assert.match(trackerQuery, /\$endCursor:String/);
});

await test('parses narrow paginated GraphQL pages', () => {
  const page = JSON.stringify({
    data: {
      repository: {
        issues: {
          nodes: [
            {
              number: 1,
              title: 't',
              labels: { nodes: [{ name: 'ready-for-agent' }] },
              milestone: { number: 12 },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  });

  assert.deepEqual(parseTrackerPages(`[${page}]`), [
    {
      number: 1,
      title: 't',
      labels: [{ name: 'ready-for-agent' }],
      milestone: { number: 12 },
    },
  ]);
});
