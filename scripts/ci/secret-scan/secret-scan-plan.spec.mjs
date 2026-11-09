import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { planSecretScan } from './secret-scan-plan.mjs';

/**
 * #1779: a `workflow_dispatch` run has no commit range, and the job used to
 * treat that as "scan everything". These tests pin the deliberate answer, and
 * the workflow wiring that applies it.
 */

const BASE = 'e74c84ddd5094275105f12a9e4a4158864aec64b';
const HEAD = '90274f2594596d556cff7e431157db374b722504';
const NULL = '0000000000000000000000000000000000000000';

await test('a push with a usable range scans exactly that range', () => {
  assert.deepEqual(
    planSecretScan({ event: 'push', baseSha: BASE, headSha: HEAD }),
    {
      mode: 'range',
      range: `${BASE}..${HEAD}`,
    },
  );
});

await test('a pull request scans the base-to-head range', () => {
  assert.deepEqual(
    planSecretScan({ event: 'pull_request', baseSha: BASE, headSha: HEAD }),
    { mode: 'range', range: `${BASE}..${HEAD}` },
  );
});

await test('a manual run is refused instead of scanning the whole history (#1779)', () => {
  const plan = planSecretScan({
    event: 'workflow_dispatch',
    baseSha: undefined,
    headSha: HEAD,
  });

  assert.equal(plan.mode, 'refused');
  assert.ok('message' in plan);
  // The message has to say why and what to do instead, or the operator is left
  // guessing after a red run.
  assert.match(plan.message, /range/i);
  assert.match(plan.message, /workflow_dispatch/);
});

await test('a manual run is refused even when it somehow carries a range', () => {
  // The trigger decides, not the payload: a dispatch is never a scan request.
  assert.equal(
    planSecretScan({ event: 'workflow_dispatch', baseSha: BASE, headSha: HEAD })
      .mode,
    'refused',
  );
});

await test('a push that starts a ref is the only path to a full-history scan', () => {
  assert.equal(
    planSecretScan({ event: 'push', baseSha: NULL, headSha: HEAD }).mode,
    'full-history',
  );
  assert.equal(
    planSecretScan({ event: 'push', baseSha: undefined, headSha: HEAD }).mode,
    'full-history',
  );
});

await test('a range that matches its own head is not a range', () => {
  assert.equal(
    planSecretScan({ event: 'push', baseSha: HEAD, headSha: HEAD }).mode,
    'full-history',
  );
});

await test('the workflow applies the plan and fails a refused manual run (#1779)', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  assert.match(
    workflow,
    /secret-scan-plan\.mjs/,
    'the job must decide through the tested plan, not an inline branch',
  );

  // A refusal has to leave the job red: a manual run that scans nothing and
  // reports success is the fast-green this repository treats as worse than a
  // slow red.
  const refusedBlock = workflow.match(/refused\)([\s\S]{0,400})/);
  assert.ok(refusedBlock, 'the job must handle the refused plan explicitly');
  assert.match(
    refusedBlock[1],
    /exit 1/,
    'a refused scan must fail the step rather than pass silently',
  );
});

await test('the workflow no longer falls through to a full history scan', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const scanStep = workflow.slice(
    workflow.indexOf('Scan changed commits'),
    workflow.indexOf('static:'),
  );

  // The old shape ran a bare `gitleaks git` with no log range in the else arm.
  // A full-history scan may still exist, but only behind a deliberate decision.
  assert.doesNotMatch(
    scanStep,
    /else\s*\n\s*gitleaks git --config \.gitleaks\.toml --redact --no-banner\s*\n\s*fi/,
    'the unguarded else must be gone; a full-history scan is now a named plan',
  );
});
