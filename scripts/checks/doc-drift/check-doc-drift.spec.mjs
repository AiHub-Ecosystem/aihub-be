import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { test } from 'node:test';

import { findDocDriftViolations } from './check-doc-drift.mjs';

/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string>} files
 * @returns {Promise<string>}
 */
async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'aihub-doc-drift-'));
  assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  return root;
}

await test('accepts reciprocal ADR status links and existing repository paths', async (/** @type {import('node:test').TestContext} */ t) => {
  const root = await fixture(t, {
    'docs/adr/0001-base.md':
      '# ADR-0001\n\nStatus: Accepted; amended by ADR-0002.\n',
    'docs/adr/0002-amendment.md':
      '# ADR-0002\n\n- Status: Accepted\n- Amends: ADR-0001\n\n[ADR-0001](0001-base.md)\n',
    'docs/operations/runbook.md':
      'Run `scripts/checks/runner.mjs` and `./scripts/checks/runner.mjs`. [SQL](../../ops/monitoring/report.sql). Host copy: `~/aihub-host/ops/runner.sh`. Glob: `src/modules/foo-*.ts`.\n',
    'scripts/checks/runner.mjs': '',
    'ops/monitoring/report.sql': '',
    'src/modules/foo-one.ts': '',
  });

  assert.deepEqual(findDocDriftViolations(root), []);
});

await test('requires the target ADR status to name the amending ADR', async (/** @type {import('node:test').TestContext} */ t) => {
  const root = await fixture(t, {
    'docs/adr/0001-base.md': '# ADR-0001\n\nStatus: Accepted.\n',
    'docs/adr/0002-amendment.md':
      '# ADR-0002\n\n- Status: Accepted\n- Supersedes ADR-0001\n- Amends ADR-0003\n\nThe operation supersedes old tokens (ADR-0004).\n',
    'docs/adr/0003-another-target.md': '# ADR-0003\n\nStatus: Accepted.\n',
  });

  assert.ok(
    findDocDriftViolations(root).some((message) =>
      message.includes('ADR-0001 status does not name ADR-0002'),
    ),
  );
  assert.ok(
    findDocDriftViolations(root).some((message) =>
      message.includes('ADR-0003 status does not name ADR-0002'),
    ),
  );
  assert.equal(
    findDocDriftViolations(root).some((message) =>
      message.includes('ADR-0004'),
    ),
    false,
  );
});

await test('rejects missing ADR links and missing repository paths in operations docs', async (/** @type {import('node:test').TestContext} */ t) => {
  const root = await fixture(t, {
    'docs/adr/0001-base.md':
      '# ADR-0001\n\nStatus: Accepted\n\nSee [ADR-0009](0009-missing.md) and [Organization Invitation Send Limit](0039-missing.md).\n',
    'docs/adr/0002-amendment.md':
      '# ADR-0002\n\n- Status: Accepted\n- Amends: ADR-0009\n',
    'docs/operations/runbook.md':
      'Run `scripts/ops/missing.sh` and `./scripts/ops/also-missing.sh` after the change, plus [SQL](../../ops/monitoring/missing.sql).\n',
  });

  const violations = findDocDriftViolations(root);
  assert.ok(violations.some((message) => message.includes('ADR-0009')));
  assert.ok(violations.some((message) => message.includes('0039-missing.md')));
  assert.ok(
    violations.some((message) => message.includes('scripts/ops/missing.sh')),
  );
  assert.ok(
    violations.some((message) =>
      message.includes('scripts/ops/also-missing.sh'),
    ),
  );
  assert.ok(
    violations.some((message) =>
      message.includes('ops/monitoring/missing.sql'),
    ),
  );
});

await test('requires every ADR to have a status line', async (/** @type {import('node:test').TestContext} */ t) => {
  const root = await fixture(t, {
    'docs/adr/0001-no-status.md': '# ADR-0001\n\nA decision.\n',
  });

  assert.ok(
    findDocDriftViolations(root).some((message) =>
      message.includes('ADR-0001 has no Status line'),
    ),
  );
});
