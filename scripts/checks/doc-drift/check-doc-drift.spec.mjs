import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob, resolve, sep } from 'node:path';
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

await test('recognises passive supersession and amendment relations in either voice (#1462)', async (/** @type {import('node:test').TestContext} */ t) => {
  const root = await fixture(t, {
    'docs/adr/0001-bare-passive.md':
      '# ADR-0001\n\nStatus: Superseded by ADR-0002\n',
    'docs/adr/0002-bare-active.md':
      '# ADR-0002\n\n- Status: Accepted\n- Supersedes ADR-0001\n',
    'docs/adr/0003-link-passive.md':
      '# ADR-0003\n\nStatus: Superseded by [ADR-0004](0004-link-active.md)\n',
    'docs/adr/0004-link-active.md':
      '# ADR-0004\n\n- Status: Accepted\n- Supersedes: [ADR-0003](0003-link-passive.md)\n',
    'docs/adr/0005-amended-passive.md':
      '# ADR-0005\n\n- Status: Accepted (identity clauses amended by [ADR-0006](0006-amender.md))\n',
    'docs/adr/0006-amender.md':
      '# ADR-0006\n\n- Status: Accepted\n- Amends: [ADR-0005](0005-amended-passive.md)\n',
  });

  assert.deepEqual(findDocDriftViolations(root), []);
});

await test('fails when a passive supersession has no acknowledgement in the successor (#1462)', async (/** @type {import('node:test').TestContext} */ t) => {
  const root = await fixture(t, {
    'docs/adr/0001-base.md': '# ADR-0001\n\nStatus: Superseded by ADR-0002\n',
    'docs/adr/0002-successor.md': '# ADR-0002\n\n- Status: Accepted\n',
  });

  assert.deepEqual(findDocDriftViolations(root), [
    'ADR-0002 status does not name ADR-0001, declared by ADR-0001',
  ]);
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

await test('the static job runs this suite in CI (#1786)', async () => {
  const workflow = await readFile(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const start = workflow.indexOf('\n  static:');
  const staticJob = workflow.slice(start, workflow.indexOf('\n  test:', start));
  assert.ok(
    staticJob.includes('bun run test:doc-drift'),
    'the static job must run bun run test:doc-drift',
  );
});

await test('CodeRabbit config is generated and has disjoint owner scopes', async () => {
  execFileSync('bun', ['run', 'generate:coderabbit-config', '--', '--check'], {
    stdio: 'pipe',
  });

  const config = await readFile('.coderabbit.yaml', 'utf8');
  assert.match(
    config,
    /^  auto_review:\r?\n    enabled: true\r?\n    drafts: true\r?\n  path_instructions:/mu,
    'CodeRabbit must review every PR, including drafts, without label or author filters',
  );
  const start = config.indexOf('  path_instructions:\n');
  const end = config.indexOf('knowledge_base:\n', start);
  assert.notEqual(start, -1, 'CodeRabbit path instructions must exist');
  assert.notEqual(
    end,
    -1,
    'CodeRabbit knowledge base must follow path instructions',
  );
  /** @type {Array<{path: string, instructions: string}>} */
  const entries = [
    ...config
      .slice(start, end)
      .matchAll(
        /^    - path: ("(?:\\.|[^"\\])*")\r?\n      instructions: ("(?:\\.|[^"\\])*")$/gmu,
      ),
  ].map((match) => {
    /** @type {unknown} */
    const path = JSON.parse(match[1] ?? 'null');
    /** @type {unknown} */
    const instructions = JSON.parse(match[2] ?? 'null');
    if (typeof path !== 'string' || typeof instructions !== 'string') {
      throw new Error('CodeRabbit path instructions must use string scalars');
    }
    return { path, instructions };
  });

  assert.equal(entries.length, 4);
  for (const role of ['api', 'identity', 'auth', 'scripts/checks']) {
    assert.ok(entries.some(({ instructions }) => instructions.includes(role)));
  }

  const trackedPaths = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split(/\r?\n/u)
    .filter(Boolean);
  const samplePaths = [
    {
      path: 'src/modules/writing/presentation/writing.controller.ts',
      owner: 'api role',
    },
    {
      path: 'src/modules/writing/presentation/request-mapper.ts',
      owner: 'api role',
    },
    {
      path: 'src/modules/identity/membership/application/create-member.ts',
      owner: 'identity role',
    },
    {
      path: 'src/modules/identity/shared/infrastructure/identity-store.ts',
      owner: 'identity role',
    },
    {
      path: 'src/modules/identity/domain/api-key.ts',
      owner: 'identity role',
    },
    {
      path: 'src/modules/identity/public/postgres-readiness.ts',
      owner: 'identity role',
    },
    {
      path: 'src/modules/identity/identity.module.ts',
      owner: 'identity role',
    },
    {
      path: 'src/modules/auth/api-keys/application/create-key.ts',
      owner: 'auth role',
    },
    {
      path: 'src/modules/auth/auth.module.ts',
      owner: 'auth role',
    },
    {
      path: 'scripts/checks/architecture/check-architecture.mjs',
      owner: 'For scripts/checks,',
    },
    { path: 'src/modules/gateway/application/grade-request.ts' },
  ];

  for (const { path, owner } of samplePaths) {
    const matchedOwners = entries.filter(({ path: pattern }) =>
      matchesGlob(path, pattern),
    );
    assert.equal(matchedOwners.length, owner ? 1 : 0, `${path} scope count`);
    if (owner) assert.ok(matchedOwners[0]?.instructions.includes(owner), path);
  }

  for (const file of new Set([
    ...trackedPaths,
    ...samplePaths.map(({ path }) => path),
  ])) {
    const matchedOwners = entries.filter(({ path }) => matchesGlob(file, path));
    assert.ok(
      matchedOwners.length <= 1,
      `${file} matched multiple CodeRabbit scopes`,
    );
  }

  for (const file of trackedPaths.filter(
    (path) =>
      path.startsWith('src/modules/identity/') &&
      !path.includes('/presentation/') &&
      !path.endsWith('.controller.ts'),
  )) {
    assert.ok(
      entries.some(
        ({ path, instructions }) =>
          instructions.includes('identity role') && matchesGlob(file, path),
      ),
      `${file} is owned by Identity but has no Identity path instruction`,
    );
  }

  const instructionLength = entries.reduce(
    (total, { instructions }) => total + instructions.length,
    0,
  );
  assert.ok(instructionLength < 20_000);
  assert.ok(
    entries
      .find(({ instructions }) => instructions.includes('scripts/checks'))
      ?.instructions.includes('check:changed and `bun run verify`'),
  );
});
