import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { test } from 'node:test';

import { buildBunTestArgs } from '../cli/run-bun-test.mjs';
import { BATCHED_GATES, runBatch } from './check-batch.cjs';
import {
  GATE_COMMANDS,
  gateInvocation,
  isEntryPoint,
  planChangedFiles,
  resolveChangedFiles,
  runCheckChanged,
} from './check-changed.mjs';

const pathCases = [
  {
    path: 'src/modules/example/domain/policy.ts',
    gates: [
      'arch-check',
      'build',
      'check:app-errors',
      'check:data-ownership',
      'check:deprecation',
      'check:doc-drift',
      'check:domain-globals',
      'check:file-size',
      'check:imports',
      'check:imports:dist',
      'check:tenant-global',
      'knip',
      'lint',
      'test:related',
      'type-check',
    ],
  },
  {
    path: 'src/modules/example/application/use-case.ts',
    gates: [
      'arch-check',
      'build',
      'check:app-errors',
      'check:data-ownership',
      'check:deprecation',
      'check:doc-drift',
      'check:file-size',
      'check:imports',
      'check:imports:dist',
      'check:tenant-global',
      'knip',
      'lint',
      'test:related',
      'type-check',
    ],
  },
  {
    path: 'src/modules/example/application/use-case.spec.ts',
    gates: [
      'check:doc-drift',
      'lint',
      'test:jest-specs',
      'test:related',
      'type-check',
    ],
  },
  {
    path: 'src/modules/example/domain/policy.spec.ts',
    gates: [
      'check:doc-drift',
      'lint',
      'test:jest-specs',
      'test:related',
      'type-check',
    ],
  },
  {
    path: 'src/modules/example/application/use-case.test.ts',
    gates: ['check:doc-drift', 'lint', 'test:related', 'type-check'],
  },
  {
    path: 'test/unit/example.spec.ts',
    gates: ['lint', 'test:jest-specs', 'test:related', 'type-check'],
  },
  {
    path: 'test/support/helper.ts',
    gates: ['lint', 'test:related', 'type-check'],
  },
  {
    path: 'test/fixtures/ai-speaking/grading-no-speech.200.json',
    gates: ['lint', 'test:related', 'type-check'],
  },
  {
    path: 'test/cli/request-log-lookup.spec.sh',
    gates: ['lint', 'test:related', 'type-check'],
  },
  {
    path: 'scripts/checks/check-app-errors.spec.ts',
    gates: [
      'check:doc-drift',
      'lint',
      'test:jest-specs',
      'test:related',
      'type-check',
    ],
  },
  {
    path: 'scripts/checks/check-app-errors.ts',
    gates: [
      'check:app-errors',
      'check:doc-drift',
      'lint',
      'test:check-app-errors',
    ],
  },
  {
    path: 'scripts/checks/check-changed.spec.mjs',
    gates: ['check:doc-drift', 'lint', 'test:check-changed'],
  },
  {
    path: 'scripts/checks/issue-triage-hook.mjs',
    gates: ['check:doc-drift', 'lint', 'test:issue-triage'],
  },
  {
    path: 'scripts/checks/check-doc-drift.mjs',
    gates: ['check:doc-drift', 'lint', 'test:doc-drift'],
  },
  {
    path: 'scripts/checks/lint-staged-config.spec.mjs',
    gates: ['check:doc-drift', 'lint', 'test:lint-staged'],
  },
  {
    path: 'scripts/ops/capacity-benchmark/capacity-benchmark.mjs',
    gates: ['check:doc-drift', 'lint', 'test:capacity-benchmark'],
  },
  {
    path: 'scripts/ops/monitoring/check-monitoring-config.cjs',
    gates: ['check:doc-drift', 'lint', 'test:monitoring-config'],
  },
  {
    path: 'prisma/schema.prisma',
    gates: [
      'build',
      'check:data-dictionary',
      'check:imports:dist',
      'check:migrations',
      'knip',
      'lint',
      'test',
      'type-check',
    ],
  },
  { path: 'docs/guide.md', gates: ['format:check'] },
  {
    path: 'docs/adr/0001-example.md',
    gates: ['check:doc-drift', 'format:check'],
  },
  {
    path: 'docs/operations/runbook.md',
    gates: ['check:doc-drift', 'format:check'],
  },
  {
    path: '.github/workflows/ci.yml',
    gates: ['format:check', 'test:secret-scan'],
  },
  {
    path: 'ops/nginx/site.conf',
    gates: ['check:doc-drift', 'check:nginx-headers', 'lint'],
  },
  {
    path: 'src/contracts/date-time-format.ts',
    gates: [
      'arch-check',
      'build',
      'check:app-errors',
      'check:data-ownership',
      'check:deprecation',
      'check:doc-drift',
      'check:file-size',
      'check:imports',
      'check:imports:dist',
      'check:tenant-global',
      'knip',
      'lint',
      'test:related',
      'type-check',
      'validate:openapi',
    ],
  },
  { path: 'openapi.json', gates: ['lint', 'validate:openapi'] },
  { path: 'openapi/v1.json', gates: ['lint', 'validate:openapi'] },
  { path: 'openapi/v2.json', gates: ['lint', 'validate:openapi'] },
  {
    path: 'scripts/ci/api-compatibility/accepted-breaking-changes.json',
    gates: ['check:doc-drift', 'lint', 'test:api-compatibility'],
  },
  { path: 'jest.config.cjs', gates: ['coverage:unit', 'lint'] },
  {
    path: 'scripts/cli/run-bun-test.mjs',
    gates: ['check:doc-drift', 'lint', 'test:check-changed'],
  },
  {
    // #1460: the gate configuration files select the gate whose behaviour
    // they control, so weakening one cannot produce a green run.
    path: 'package.json',
    gates: ['knip', 'test:check-changed'],
  },
  { path: 'tsconfig.json', gates: ['type-check'] },
  { path: 'tsconfig.scripts.json', gates: ['type-check:scripts'] },
  { path: 'knip.json', gates: ['knip'] },
  { path: 'biome.json', gates: ['lint'] },
  // #1768: the remaining gate-tool configuration files follow the same rule.
  { path: '.dependency-cruiser.cjs', gates: ['arch-check'] },
  { path: '.oxlintrc.json', gates: ['lint'] },
  { path: 'nest-cli.json', gates: ['build'] },
  { path: 'tsconfig.build.json', gates: ['build'] },
  { path: '.squawk.toml', gates: ['check:migrations'] },
  {
    // #1777: the spec that pins the cached format:check command and proves
    // the cache cannot mask a real finding. `scripts/` is a doc-drift input,
    // so the gate set is widened by that layer.
    path: 'scripts/checks/format-check-cache.spec.mjs',
    gates: ['check:doc-drift', 'lint', 'test:format-check'],
  },
  {
    // #1779: the tested secret-scan plan, and the spec that pins both the
    // decision and the workflow wiring that applies it.
    path: 'scripts/ci/secret-scan/secret-scan-plan.mjs',
    gates: ['check:doc-drift', 'lint', 'test:secret-scan'],
  },
  {
    path: 'scripts/ci/secret-scan/secret-scan-plan.spec.mjs',
    gates: ['check:doc-drift', 'lint', 'test:secret-scan'],
  },
  { path: '.prettierrc', gates: ['format:check'] },
  { path: '.prettierignore', gates: ['format:check'] },
  { path: '.lintstagedrc', gates: ['test:lint-staged'] },
  // #1767: each husky hook selects the gate that asserts its content.
  { path: '.husky/pre-commit', gates: ['test:lint-staged'] },
  { path: '.husky/commit-msg', gates: ['test:commit-message'] },
  // #1767: the whole checker directory selects the suite that exercises it,
  // not only its accepted-breaking-changes list.
  {
    path: 'scripts/ci/api-compatibility/check-release.mjs',
    gates: ['check:doc-drift', 'lint', 'test:api-compatibility'],
  },
  {
    path: 'scripts/ci/api-compatibility/check.mjs',
    gates: ['check:doc-drift', 'lint', 'test:api-compatibility'],
  },
  {
    path: 'scripts/ci/api-compatibility/fixtures/example.json',
    gates: ['check:doc-drift', 'lint', 'test:api-compatibility'],
  },
  { path: '.swcrc', gates: ['build'] },
  {
    path: 'ops/monitoring/alert.rules.yml',
    gates: ['check:doc-drift', 'format:check', 'test:monitoring-config'],
  },
  {
    path: 'scripts/ops/host-jobs/container-watchdog.sh',
    gates: ['check:doc-drift', 'lint', 'test:shell-specs'],
  },
  {
    path: 'scripts/ops/backups/restore-postgres-rehearsal.sh',
    gates: ['check:doc-drift', 'lint', 'test:shell-specs'],
  },
  {
    path: 'scripts/ops/monitoring/probe-sandbox-mint.sh',
    gates: ['check:doc-drift', 'lint', 'test:shell-specs'],
  },
  {
    path: 'docker-compose.production.yml',
    gates: ['check:compose', 'format:check'],
  },
  {
    path: 'docker-compose.yml',
    gates: ['check:compose', 'format:check'],
  },
  {
    path: 'ops/firewall/guard.Dockerfile',
    gates: ['check:doc-drift'],
  },
  {
    path: 'scripts/ci/image/image-boot-check.sh',
    gates: ['check:doc-drift'],
  },
  {
    path: 'scripts/ci/image/host-job-image-check.cjs',
    gates: ['check:doc-drift', 'lint', 'test:related'],
  },
];

for (const { path, gates } of pathCases) {
  await test(`${path} maps to its exact gates`, () => {
    assert.deepEqual(planChangedFiles([path]).gates, gates);
  });
}

await test('a changed non-TypeScript spec does not select the Jest gate (#1631)', () => {
  const { gates } = planChangedFiles(['scripts/checks/check-changed.spec.mjs']);
  assert.ok(!gates.includes('test:jest-specs'));
});

await test('a test-only diff skips production-only gates (#1634)', () => {
  const { gates } = planChangedFiles([
    'src/modules/example/application/use-case.spec.ts',
  ]);
  for (const gate of [
    'build',
    'knip',
    'check:app-errors',
    'check:data-ownership',
    'check:imports:dist',
  ]) {
    assert.ok(!gates.includes(gate), `${gate} must not run for a spec diff`);
  }
});

await test('a mixed diff keeps the full union of gates (#1634)', () => {
  const mixed = planChangedFiles([
    'src/modules/example/application/use-case.ts',
    'src/modules/example/application/use-case.spec.ts',
  ]).gates;
  assert.deepEqual(mixed, [
    'arch-check',
    'build',
    'check:app-errors',
    'check:data-ownership',
    'check:deprecation',
    'check:doc-drift',
    'check:file-size',
    'check:imports',
    'check:imports:dist',
    'check:tenant-global',
    'knip',
    'lint',
    'test:jest-specs',
    'test:related',
    'type-check',
  ]);
});

await test('the Jest gate gets the changed specs that still exist, normalized and sorted (#1631)', () => {
  const files = [
    'src/b.spec.ts',
    'src\\a.spec.ts',
    'src/gone.spec.ts',
    'scripts/x.spec.mjs',
    'src/c.ts',
  ];
  assert.deepEqual(
    gateInvocation('test:jest-specs', files, (p) => p !== 'src/gone.spec.ts'),
    {
      script: 'test:jest-specs',
      args: ['src/a.spec.ts', 'src/b.spec.ts'],
    },
  );
});

await test('the Jest gate has nothing to run when every changed spec was deleted (#1631)', () => {
  assert.equal(
    gateInvocation('test:jest-specs', ['src/gone.spec.ts'], () => false),
    undefined,
  );
});

await test('other gates run with no arguments (#1631)', () => {
  assert.deepEqual(gateInvocation('lint', ['src/a.spec.ts']), {
    script: 'lint',
    args: [],
  });
});

await test('the Jest gate script takes paths last, runs no coverage and passes on ignored specs (#1631)', () => {
  const packageJson = /** @type {{scripts: Record<string, string>}} */ (
    JSON.parse(readFileSync('package.json', 'utf8'))
  );
  const command = packageJson.scripts[GATE_COMMANDS['test:jest-specs']] ?? '';
  // A spec in `testPathIgnorePatterns` is "no tests found" to Jest; the flag
  // keeps that from failing the gate.
  assert.ok(command.includes('--passWithNoTests'));
  assert.ok(command.includes('--coverage=false'));
  // `bun run` appends the paths to the end of the command.
  assert.ok(command.endsWith('--runTestsByPath'));
});

await test('a domain source file still runs type-check and related specs', () => {
  const plan = planChangedFiles(['src/modules/example/domain/policy.ts']);
  if (!('gates' in plan)) throw new Error('expected a changed-file plan');
  const { gates } = plan;
  assert.ok(gates.includes('type-check'));
  assert.ok(gates.includes('test:related'));
  assert.ok(gates.includes('check:domain-globals'));
});

await test('changed source paths keep the documentation path check selected', () => {
  assert.ok(
    planChangedFiles(['src/modules/removed-operation.ts']).gates.includes(
      'check:doc-drift',
    ),
  );
});

await test('the Bun runner defaults to TypeScript unit specs', () => {
  assert.equal(buildBunTestArgs([]).at(-1), '.spec.ts');
});

await test('the Bun runner never loads a local .env file (#1627)', () => {
  for (const args of [[], ['--', 'test/example.spec.ts'], ['--', '--watch']]) {
    assert.ok(buildBunTestArgs(args).includes('--no-env-file'));
  }
});

await test('the Bun runner accepts a focused spec path', () => {
  assert.equal(
    buildBunTestArgs(['--', 'test/example.spec.ts']).at(-1),
    'test/example.spec.ts',
  );
});

await test('the Bun runner preserves substring and directory filters', () => {
  for (const filter of [
    'writing-chart-upload',
    'src/modules/writing/chart-uploads/domain',
  ]) {
    const args = buildBunTestArgs(['--', filter]);
    assert.ok(args.includes(filter));
    assert.notEqual(args.at(-1), '.spec.ts');
  }
});

await test('the Bun runner keeps the default when -t has a separate value', () => {
  assert.equal(
    buildBunTestArgs(['--', '-t', 'writing chart upload']).at(-1),
    '.spec.ts',
  );
});

await test('the Bun runner forwards changed and watch options with default specs', () => {
  const args = buildBunTestArgs(['--', '--changed=origin/main', '--watch']);
  assert.ok(args.includes('--changed=origin/main'));
  assert.ok(args.includes('--watch'));
  assert.equal(args.at(-1), '.spec.ts');
});

await test('wrappers whose directory has no co-located suite select documentation drift only (#1460)', () => {
  for (const path of [
    'scripts/ops/firewall/docker-user-guard.sh',
    'scripts/ops/speaking/speaking-gateway-smoke.sh',
    'scripts/ops/blue-green/blue-green-host.sh',
    'scripts/ops/logs/request-log-lookup.sh',
  ]) {
    assert.deepEqual(planChangedFiles([path]).gates, ['check:doc-drift']);
  }
});

await test('SAST-only CodeQL inputs select no local gate and say so (#1460)', () => {
  for (const path of [
    '.github/codeql/triage.json',
    '.github/codeql/queries/RawSqlInjection.ql',
    '.github/codeql/tests/raw-sql/raw-sql.expected',
  ]) {
    // The explicit no-gate answer is observable as its own full-verify
    // reason, distinct from an unclassified path naming the file.
    assert.deepEqual(planChangedFiles([path]), {
      fullVerify: true,
      reason: 'no gate can break the changed files',
    });
  }
});

await test('a no-gate path does not force the full loop onto its mixed diff (#1460)', () => {
  assert.deepEqual(
    planChangedFiles(['.github/codeql/triage.json', 'docs/guide.md']).gates,
    ['format:check'],
  );
});

await test('Vault policies and templates select no local gate and say so (#1767)', () => {
  // Provisioning is a deploy action: no local gate reads these files, so the
  // recorded answer is a no-gate diff rather than an unclassified fall-through.
  // `ops/` is also a documentation-drift input, so the answer is doc drift
  // alone, and `check:doc-drift` passing means every other gate is genuinely
  // unaffected by the change.
  for (const path of [
    'ops/vault/policies/aihub-production-runtime.hcl',
    'ops/vault/agent/aihub-runtime.hcl',
    'ops/vault/templates/runtime-secrets.json.ctmpl',
    'ops/vault/templates/pgbouncer.ini.ctmpl',
  ]) {
    assert.deepEqual(planChangedFiles([path]).gates, ['check:doc-drift']);
  }
});

await test('a Vault template change does not force the full loop onto its mixed diff (#1767)', () => {
  assert.deepEqual(
    planChangedFiles([
      'ops/vault/templates/runtime-secrets.json.ctmpl',
      'docs/guide.md',
    ]).gates,
    ['check:doc-drift', 'format:check'],
  );
});

await test('the shell-spec gate gets the co-located suites of the changed wrappers (#1460)', () => {
  const listDir = (/** @type {string} */ dir) =>
    dir === 'scripts/ops/host-jobs'
      ? [
          'container-watchdog.spec.sh',
          'host-scheduled-job.spec.sh',
          'install-host-jobs.sh',
        ]
      : [];
  assert.deepEqual(
    gateInvocation(
      'test:shell-specs',
      [
        'scripts/ops/host-jobs/container-watchdog.sh',
        'scripts\\ops\\host-jobs\\install-host-jobs.sh',
        'scripts/ops/speaking/speaking-gateway-smoke.sh',
        'src/a.ts',
      ],
      () => true,
      listDir,
    ),
    {
      script: 'test:shell-specs',
      args: [
        'scripts/ops/host-jobs/container-watchdog.spec.sh',
        'scripts/ops/host-jobs/host-scheduled-job.spec.sh',
      ],
    },
  );
});

await test('the shell-spec gate has nothing to run when no changed wrapper exists', () => {
  assert.equal(
    gateInvocation(
      'test:shell-specs',
      ['scripts/ops/host-jobs/gone.sh'],
      () => false,
    ),
    undefined,
  );
});

await test('the shell-spec gate script runs the selected suites through bash', () => {
  const packageJson = /** @type {{scripts: Record<string, string>}} */ (
    JSON.parse(readFileSync('package.json', 'utf8'))
  );
  const command = packageJson.scripts[GATE_COMMANDS['test:shell-specs']] ?? '';
  assert.ok(command.includes('run-shell-specs.mjs'));
});

await test('unknown paths force full verification, including mixed changes', () => {
  assert.deepEqual(planChangedFiles(['new-file.bin']), {
    fullVerify: true,
    reason: 'unclassified path: new-file.bin',
  });
  assert.equal(
    planChangedFiles(['src/modules/example/domain/policy.ts', 'new-file.bin'])
      .fullVerify,
    true,
  );
});

await test('empty changed set forces full verification rather than doing nothing', () => {
  assert.equal(planChangedFiles([]).fullVerify, true);
});

await test('changed files union committed, staged, unstaged, and untracked paths', () => {
  const outputs = new Map([
    ['merge-base HEAD origin/main', 'merge-base-sha'],
    ['diff --no-renames --name-only merge-base-sha HEAD', 'committed.ts'],
    ['diff --no-renames --name-only', 'unstaged.ts'],
    ['diff --no-renames --cached --name-only', 'staged.ts'],
    ['ls-files --others --exclude-standard', 'new.ts'],
  ]);
  assert.deepEqual(
    resolveChangedFiles((args) => outputs.get(args.join(' ')) ?? ''),
    ['committed.ts', 'unstaged.ts', 'staged.ts', 'new.ts'],
  );
});

await test('renames preserve the old documentation path for gate selection', () => {
  const outputs = new Map([
    ['merge-base HEAD origin/main', 'merge-base-sha'],
    [
      'diff --no-renames --name-only merge-base-sha HEAD',
      'docs/adr/0001-retired.md\ndocs/history/0001-retired.md',
    ],
    ['diff --no-renames --name-only', ''],
    ['diff --no-renames --cached --name-only', ''],
    ['ls-files --others --exclude-standard', ''],
  ]);
  const files = resolveChangedFiles(
    (args) => outputs.get(args.join(' ')) ?? '',
  );

  assert.deepEqual(files, [
    'docs/adr/0001-retired.md',
    'docs/history/0001-retired.md',
  ]);
  assert.ok(planChangedFiles(files).gates.includes('check:doc-drift'));
});

await test('unresolvable git state falls back to full verify and runs no reduced gate', async () => {
  let fallbackCalls = 0;
  const gateCalls = [];
  const result = await runCheckChanged({
    resolveFiles: () => {
      throw new Error('origin/main is missing');
    },
    runFullVerify: () => {
      fallbackCalls += 1;
    },
    runGate: (name) => gateCalls.push(name),
    runBatchGates: async () => ({ failed: [] }),
  });
  assert.equal(result, 'full-verify');
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(gateCalls, []);
});

await test('plans independent gates as one concurrent batch and keeps dependents sequential', async () => {
  /** @type {string[]} */
  const order = [];
  const result = await runCheckChanged({
    resolveFiles: () => ['src/modules/example/domain/policy.ts'],
    runGate: async (gate) => {
      order.push(`gate:${gate}`);
      return 0;
    },
    runBatchGates: async (/** @type {string[]} */ gates) => {
      order.push(`batch:${gates.join(',')}`);
      assert.deepEqual(gates, [
        'check:data-ownership',
        'check:deprecation',
        'check:doc-drift',
        'check:domain-globals',
        'check:file-size',
        'check:imports',
        'check:tenant-global',
      ]);
      return { failed: [] };
    },
    runFullVerify: () => undefined,
  });

  assert.equal(result, 'passed');
  assert.deepEqual(order.slice(0, 2), [
    'batch:check:data-ownership,check:deprecation,check:doc-drift,check:domain-globals,check:file-size,check:imports,check:tenant-global',
    'gate:arch-check',
  ]);
  for (const gate of ['lint', 'type-check', 'build', 'test:related']) {
    assert.ok(order.includes(`gate:${gate}`));
  }
});

await test('reports the failing concurrent gate and stops dependent gates', async () => {
  /** @type {string[]} */
  const order = [];
  const result = await runCheckChanged({
    resolveFiles: () => ['src/modules/example/domain/policy.ts'],
    runGate: async (gate) => {
      order.push(gate);
      return 0;
    },
    runBatchGates: async () => {
      order.push('batch');
      return { failed: ['check:file-size'] };
    },
    runFullVerify: () => undefined,
  });

  assert.equal(result, 'check:file-size');
  assert.deepEqual(order, ['batch']);
});

await test('keeps a single batchable gate sequential', async () => {
  /** @type {string[]} */
  const order = [];
  const result = await runCheckChanged({
    resolveFiles: () => ['docs/guide.md'],
    runGate: async (gate) => {
      order.push(`gate:${gate}`);
      return 0;
    },
    runBatchGates: async () => {
      order.push('batch');
      return { failed: [] };
    },
    runFullVerify: () => undefined,
  });

  assert.equal(result, 'passed');
  assert.equal(order.includes('batch'), false);
  assert.deepEqual(order, ['gate:format:check']);
});

await test('buffers concurrent gate output in declared order and names the failure', async () => {
  /** @type {string[]} */
  const lines = [];
  const outcome = await runBatch({
    gates: ['check:file-size', 'check:imports', 'check:deprecation'],
    freeBytes: 3 * 256 * 1024 ** 2,
    run: async (/** @type {string} */ gate) => {
      await new Promise((resolve) =>
        setTimeout(resolve, gate === 'check:file-size' ? 20 : 1),
      );
      return gate === 'check:imports'
        ? { code: 1, output: `${gate} failed\n` }
        : { code: 0, output: `${gate} output\n` };
    },
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  });

  assert.equal(outcome.peakInFlight, 3);
  assert.deepEqual(outcome.failed, ['check:imports']);
  assert.deepEqual(
    lines.filter((line) => line.startsWith('$ ')),
    ['$ bun run check:imports'],
  );
  assert.ok(lines.includes('check:imports failed'));
  assert.ok(lines.includes('check:batch: also failed check:imports') === false);
});

await test('the entry-point comparison holds on both path shapes', () => {
  // pathToFileURL reads a path in the running platform's syntax, so each
  // platform checks its own argv shape: a Windows path is relative on Linux.
  const [moduleUrl, argv1] =
    process.platform === 'win32'
      ? [
          'file:///D:/repo/scripts/checks/check-changed.mjs',
          String.raw`D:\repo\scripts\checks\check-changed.mjs`,
        ]
      : [
          'file:///repo/scripts/checks/check-changed.mjs',
          '/repo/scripts/checks/check-changed.mjs',
        ];
  assert.equal(
    isEntryPoint(moduleUrl, argv1),
    true,
    'the argv path must match, or the script exits 0 having run nothing',
  );
  assert.equal(
    isEntryPoint(
      'file:///repo/scripts/checks/check-changed.mjs',
      '/repo/scripts/checks/other.mjs',
    ),
    false,
  );
  assert.equal(
    isEntryPoint('file:///repo/check-changed.mjs', undefined),
    false,
  );
});

await test('all gates in bun run verify have commands and a tested path mapping', () => {
  const packageJson = /** @type {{scripts: Record<string, string>}} */ (
    JSON.parse(readFileSync('package.json', 'utf8'))
  );
  const invoked = [
    ...packageJson.scripts.verify.matchAll(/\bbun run\s+([\w:-]+)/g),
  ].map((match) => match[1] ?? '');
  // `check:batch` is one step that runs several gates. The guarantee is about
  // the gates, so expand the step into its declared members rather than letting
  // a single step name stand in for the coverage of eleven.
  const expanded = invoked.flatMap((gate) =>
    gate === 'check:batch' ? BATCHED_GATES : [gate],
  );
  const mapped = new Set(pathCases.flatMap(({ gates }) => gates));
  for (const gate of expanded) {
    assert.ok(
      Object.hasOwn(GATE_COMMANDS, gate),
      `missing command for verify gate ${gate}`,
    );
    assert.ok(
      mapped.has(gate),
      `verify gate ${gate} has no tested path mapping`,
    );
  }
  // The batch is a verify-chain step only. The subset gate keeps selecting
  // individual gates, because narrowing to fewer checks is its whole purpose.
  assert.ok(!Object.hasOwn(GATE_COMMANDS, 'check:batch'));
  assert.ok(invoked.includes('check:batch'));
});

await test('check:changed stays out of verify and CI', () => {
  const packageJson = /** @type {{scripts: Record<string, string>}} */ (
    JSON.parse(readFileSync('package.json', 'utf8'))
  );
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.ok(!packageJson.scripts.verify.includes('check:changed'));
  assert.ok(!workflow.includes('check:changed'));
});

// #1766: the compose gate runs the same two validators CI runs, over the same
// rendered production config, so a compose change exercises locally what CI
// would catch.
await test('check:compose runs the validators CI runs over the rendered config', () => {
  const packageJson = /** @type {{scripts: Record<string, string>}} */ (
    JSON.parse(readFileSync('package.json', 'utf8'))
  );
  const command = packageJson.scripts[GATE_COMMANDS['check:compose']] ?? '';
  assert.ok(
    command.includes('docker-compose.production.yml'),
    'the compose gate must render the production compose file',
  );
  assert.ok(
    command.includes('scripts/ci/compose/check-production-compose-logs.cjs'),
    'the compose gate must run the log-bounds validator',
  );
  assert.ok(
    command.includes('scripts/ci/compose/check-trusted-proxy-compose.cjs'),
    'the compose gate must run the trusted-proxy validator',
  );
});

// #1766: the image gate CI runs — build the production image, check the
// shipped paths, boot it and wait for health — needs a docker daemon and a
// multi-minute production build, so it proves unrunnable on the dev hosts
// this repo is edited on. The no-gate answer is recorded instead of a gate
// that fails everywhere; the full loop still answers for these files.
await test('image inputs select no local gate and say so (#1766)', () => {
  // The root Dockerfile is not a documentation-drift input, so its no-gate
  // answer is observable as its own full-verify reason, distinct from an
  // unclassified path naming the file.
  assert.deepEqual(planChangedFiles(['Dockerfile']), {
    fullVerify: true,
    reason: 'no gate can break the changed files',
  });
  for (const path of [
    'ops/firewall/guard.Dockerfile',
    'ops/monitoring/ssh-tunnel.Dockerfile',
    'scripts/ci/image/image-boot-check.sh',
  ]) {
    assert.deepEqual(planChangedFiles([path]).gates, ['check:doc-drift']);
  }
});
