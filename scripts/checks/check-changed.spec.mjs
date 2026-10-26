import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { test } from 'node:test';

import { BATCHED_GATES } from './check-batch.cjs';
import {
  GATE_COMMANDS,
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
  { path: '.github/workflows/ci.yml', gates: ['format:check'] },
  {
    path: 'ops/nginx/site.conf',
    gates: ['check:doc-drift', 'check:nginx-headers', 'lint'],
  },
  {
    path: 'src/contracts/date-time-format.ts',
    gates: [
      'arch-check',
      'build',
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
  { path: 'jest.config.cjs', gates: ['lint', 'test'] },
];

for (const { path, gates } of pathCases) {
  await test(`${path} maps to its exact gates`, () => {
    assert.deepEqual(planChangedFiles([path]).gates, gates);
  });
}

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

await test('unresolvable git state falls back to full verify and runs no reduced gate', () => {
  let fallbackCalls = 0;
  const gateCalls = [];
  const result = runCheckChanged({
    resolveFiles: () => {
      throw new Error('origin/main is missing');
    },
    runFullVerify: () => {
      fallbackCalls += 1;
    },
    runGate: (name) => gateCalls.push(name),
  });
  assert.equal(result, 'full-verify');
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(gateCalls, []);
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

await test('all gates in pnpm verify have commands and a tested path mapping', () => {
  const packageJson = /** @type {{scripts: Record<string, string>}} */ (
    JSON.parse(readFileSync('package.json', 'utf8'))
  );
  const invoked = [
    ...packageJson.scripts.verify.matchAll(/\bpnpm\s+([\w:-]+)/g),
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
