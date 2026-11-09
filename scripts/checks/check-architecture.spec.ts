import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import architectureConfig from '../../.dependency-cruiser.cjs';
import { collectSourceTextFailures } from './check-architecture.mjs';
import cacheHelpers from './dependency-cruiser-cache.cjs';

type DependencyCruiserConfig = typeof architectureConfig;

interface DependencyCruiserViolation {
  readonly rule: { readonly name: string };
  readonly from: string;
  readonly to: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDependencyCruiserViolations(
  value: unknown,
): DependencyCruiserViolation[] {
  if (!isRecord(value)) {
    throw new Error('dependency-cruiser output has no summary');
  }
  const summary = value.summary;
  if (!isRecord(summary) || !Array.isArray(summary.violations)) {
    throw new Error('dependency-cruiser output has no violations list');
  }

  return summary.violations.map((violation) => {
    if (!isRecord(violation) || !isRecord(violation.rule)) {
      throw new Error(
        'dependency-cruiser output contains a malformed violation',
      );
    }
    const { name } = violation.rule;
    const { from, to } = violation;
    if (
      typeof name !== 'string' ||
      typeof from !== 'string' ||
      typeof to !== 'string'
    ) {
      throw new Error(
        'dependency-cruiser output contains a malformed violation',
      );
    }
    return {
      rule: { name },
      from,
      to,
    };
  });
}

const rules =
  architectureConfig.forbidden as DependencyCruiserConfig['forbidden'];
const crossModuleRule = rules.find(
  (rule) => rule.name === 'no-cross-module-internal-import',
);
const cliRule = rules.find(
  (rule) => rule.name === 'no-cli-module-internal-import',
);
const identityAuthRule = rules.find(
  (rule) => rule.name === 'no-identity-auth-internal-import',
);
const businessGatewayRule = rules.find(
  (rule) => rule.name === 'no-business-to-gateway-internal-import',
);
const avatarGatewayRule = rules.find(
  (rule) => rule.name === 'no-avatar-gateway-import',
);

function matches(pattern: string | string[], path: string): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((entry) => new RegExp(entry).test(path));
}

const repoRoot = process.cwd();
const archCheckScript = join(
  repoRoot,
  'scripts',
  'checks',
  'check-architecture.mjs',
);
let workspace: string | undefined;

/**
 * A throwaway copy of the files `check-architecture.mjs` reads, built once per
 * spec file. Every fixture is written here and the script runs with this
 * directory as its root, so a probe file never exists in the real `src/` tree:
 * a killed run cannot leave one behind, and a gate that reads `src/` while this
 * spec runs never sees it (#1636). The copy sits under `temp/` so module
 * resolution still walks up to the repository's `node_modules`.
 */
function workspaceRoot(): string {
  if (workspace) return workspace;

  const temp = join(repoRoot, 'temp');
  mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, 'arch-spec-'));
  cpSync(join(repoRoot, 'src'), join(root, 'src'), { recursive: true });
  // `tsconfig.json` maps the generated clients to `dist/generated`.
  const generated = join(repoRoot, 'dist', 'generated');
  if (existsSync(generated)) {
    cpSync(generated, join(root, 'dist', 'generated'), { recursive: true });
  }
  for (const name of [
    '.dependency-cruiser.cjs',
    'tsconfig.json',
    'package.json',
    'bun.lock',
  ]) {
    copyFileSync(join(repoRoot, name), join(root, name));
  }
  // The script scans these roots too, and specs under `src/` import from them.
  for (const name of ['scripts', 'test']) {
    cpSync(join(repoRoot, name), join(root, name), { recursive: true });
  }
  workspace = root;
  return root;
}

function spawnArchCheck(cwd: string = workspaceRoot()) {
  return spawnSync(process.execPath, [archCheckScript], {
    cwd,
    encoding: 'utf8',
  });
}

/**
 * Runs the source-text rules over fixture files held in memory (#1484). `path`
 * is relative to the repository root; nothing is written to disk and nothing
 * else is read, so one call costs a few milliseconds where a spawned CLI cost
 * seconds. `status` and `output` mirror what the CLI would have answered.
 */
function checkFixtures(fixtures: ReadonlyArray<readonly [string, string]>): {
  status: number;
  output: string;
  failures: string[];
} {
  const sources = new Map(
    fixtures.map(([path, source]) => [join(repoRoot, path), source]),
  );
  const { failures } = collectSourceTextFailures({
    root: repoRoot,
    files: [...sources.keys()],
    readSource: (file) => sources.get(file) ?? '',
  });

  return {
    status: failures.length > 0 ? 1 : 0,
    output: failures
      .map((message) => `Architecture check failed: ${message}\n`)
      .join(''),
    failures,
  };
}

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  try {
    // Only an empty `temp/` goes; another run's directory keeps it.
    rmdirSync(join(repoRoot, 'temp'));
  } catch {
    // not empty or already gone
  }
});

describe('dependency-cruiser cache inputs', () => {
  it('changes the cache directory when a policy or resolver input changes', () => {
    const root = process.cwd();
    const inputs = [
      'dependency-cruiser rules',
      'TypeScript path aliases',
      'package manifest',
      'dependency lockfile',
    ];
    const cacheDirectory = cacheHelpers.dependencyCruiserCacheDirectory(
      root,
      inputs,
    );

    for (const index of inputs.keys()) {
      const changedInputs = [...inputs];
      changedInputs[index] = `${changedInputs[index]} changed`;
      expect(
        cacheHelpers.dependencyCruiserCacheDirectory(root, changedInputs),
      ).not.toBe(cacheDirectory);
    }
  });
});

describe('dependency-cruiser module discovery', () => {
  it('sweeps src/modules once and reads each source file at most once', () => {
    const probe = `
      const fs = require('node:fs');
      const path = require('node:path');
      const modules = path.join(process.cwd(), 'src', 'modules');
      const reads = new Map();
      let enumerations = 0;
      const originalReaddir = fs.readdirSync;
      const originalReadFile = fs.readFileSync;
      fs.readdirSync = function (directory, ...args) {
        if (typeof directory === 'string' && directory.startsWith(modules)) {
          enumerations += 1;
        }
        return originalReaddir.call(this, directory, ...args);
      };
      fs.readFileSync = function (file, ...args) {
        if (typeof file === 'string' && file.startsWith(modules)) {
          reads.set(file, (reads.get(file) ?? 0) + 1);
        }
        return originalReadFile.call(this, file, ...args);
      };
      const config = require(path.join(process.cwd(), '.dependency-cruiser.cjs'));
      const rule = config.forbidden.find(
        (entry) => entry.name === 'no-cross-module-internal-import',
      );
      console.log(JSON.stringify({
        enumerations,
        reads: reads.size,
        maxReads: Math.max(...reads.values()),
        pathNot: rule.to.pathNot,
      }));
    `;
    const result = spawnSync(process.execPath, ['-e', probe], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const counts = JSON.parse(result.stdout.trim()) as {
      enumerations: number;
      maxReads: number;
      pathNot: string[];
    };
    expect(counts.enumerations).toBe(1);
    expect(counts.maxReads).toBeLessThanOrEqual(1);
    expect(counts.pathNot).toEqual(crossModuleRule?.to.pathNot);
  });
});

/**
 * The rule matches any module on the `to` side and exempts the seam through
 * `to.pathNot`. Getting that wrong is silent in both directions: a `pathNot`
 * that stops matching reports nothing at all, and a `pathNot` that keeps
 * matching reports the whole tree. The real-tree test at the bottom is what
 * pins the effect; these cases pin which paths the rule reads as seam.
 */
describe('cross-module import rules', () => {
  it('fails on imports outside the published seams', () => {
    expect(crossModuleRule?.severity).toBe('error');
    expect(cliRule?.severity).toBe('error');
  });

  it('covers every module pair with one rule, skipping the importing module', () => {
    // Not excluded by `pathNot` means in scope for the rule, so a dependency on
    // it is the thing the rule exists to report, from any module.
    expect(
      matches(crossModuleRule?.to.path ?? '', 'src/modules/identity/'),
    ).toBe(true);
    expect(
      matches(crossModuleRule?.to.path ?? '', 'src/modules/writing/'),
    ).toBe(true);

    expect(
      matches(
        crossModuleRule?.to.pathNot ?? [],
        'src/modules/identity/audit/presentation/audit-cursor.ts',
      ),
    ).toBe(false);
  });

  it('excludes the seam from the rule', () => {
    // `pathNot` matching is what exempts a target, so every seam entry has to
    // match it and nothing else may.
    const pathNot = crossModuleRule?.to.pathNot ?? [];

    expect(matches(pathNot, 'src/modules/gateway/gateway.module.ts')).toBe(
      true,
    );
    expect(
      matches(pathNot, 'src/modules/gateway/application/rate-limiter.port.ts'),
    ).toBe(true);
    expect(
      matches(
        pathNot,
        'src/modules/gateway/application/grading-orchestrator.ts',
      ),
    ).toBe(false);
    expect(
      matches(pathNot, 'src/modules/gateway/public/graded-pipeline.ts'),
    ).toBe(true);
    expect(
      matches(
        pathNot,
        'src/modules/gateway/presentation/graded-pipeline-context.ts',
      ),
    ).toBe(false);
  });

  it('treats a file declaring module fastify as shared, read from source', () => {
    const pathNot = crossModuleRule?.to.pathNot ?? [];

    expect(
      matches(
        pathNot,
        'src/modules/identity/shared/presentation/authenticated-request.ts',
      ),
    ).toBe(true);
    // Another Identity presentation file remains private.
    expect(
      matches(
        pathNot,
        'src/modules/identity/audit/presentation/audit-cursor.ts',
      ),
    ).toBe(false);
    // #674: an application file no longer counts as a shared seam, even if it
    // declares module 'fastify'.
    expect(
      matches(pathNot, 'src/modules/metering/application/metering-evidence.ts'),
    ).toBe(false);
  });

  it('excludes spec files from the importing side', () => {
    expect(crossModuleRule?.from.pathNot).toBe('[.]spec[.]ts$');
  });
});

/**
 * #1733: two edges carry enough cross-module traffic that the general seam set
 * is wider than they should be, so each is pinned to a narrower one, and one
 * edge (avatar to gateway) is pinned to nothing at all. The unit tests here pin
 * each rule's pattern shape against the real tree's known files; the real-tree
 * block below pins that the rules stay silent while they match nothing.
 */
describe('restricted-edge import rules', () => {
  it('reports the identity-to-auth edge as an error', () => {
    expect(identityAuthRule?.severity).toBe('error');
    expect(
      matches(
        identityAuthRule?.from.path ?? '',
        'src/modules/identity/audit/presentation/audit-cursor.ts',
      ),
    ).toBe(true);
    expect(
      matches(
        identityAuthRule?.to.path ?? '',
        'src/modules/auth/accounts/application/user-account.port.ts',
      ),
    ).toBe(true);
    // Other modules keep the general cross-module rule only.
    expect(
      matches(
        identityAuthRule?.from.path ?? '',
        'src/modules/writing/grading/presentation/writing-grading.controller.ts',
      ),
    ).toBe(false);
  });

  it('narrows the identity-to-auth seams and keeps the rest of auth private', () => {
    const pathNot = identityAuthRule?.to.pathNot ?? [];

    // An application port, as the issue states.
    expect(
      matches(
        pathNot,
        'src/modules/auth/email-delivery/application/email-outbox.port.ts',
      ),
    ).toBe(true);
    // A public/ facade.
    expect(matches(pathNot, 'src/modules/auth/public/local-auth.ts')).toBe(
      true,
    );
    // A Nest-exported provider: AuthModule exports UserAccessJwtGuard, so the
    // file holding it is seam even though it sits under presentation/.
    expect(
      matches(
        pathNot,
        'src/modules/auth/web-sessions/presentation/user-access-jwt.guard.ts',
      ),
    ).toBe(true);
    // The module composition root, which composes AuthModule into Identity.
    expect(matches(pathNot, 'src/modules/auth/auth.module.ts')).toBe(true);

    // The general rule also treats a file declaring `module 'fastify'` as seam;
    // this edge does not offer that exemption. No auth file declares it today
    // (the one guard that does is seam through Nest exports above), so the
    // narrowing is preventive: it holds when a future auth file declares the
    // shared request primitive.
    expect(
      matches(pathNot, 'src/modules/auth/shared/presentation/auth-request.ts'),
    ).toBe(false);
    // Auth internals stay private to identity.
    expect(
      matches(
        pathNot,
        'src/modules/auth/accounts/infrastructure/postgres-user-account.repository.ts',
      ),
    ).toBe(false);
    expect(
      matches(
        pathNot,
        'src/modules/auth/testing/user-access-token-verifier.stub.ts',
      ),
    ).toBe(false);
  });

  it('reports writing and speaking imports of gateway as an error, not other modules', () => {
    expect(businessGatewayRule?.severity).toBe('error');
    expect(
      matches(
        businessGatewayRule?.from.path ?? '',
        'src/modules/writing/grading/presentation/writing-grading.controller.ts',
      ),
    ).toBe(true);
    expect(
      matches(
        businessGatewayRule?.from.path ?? '',
        'src/modules/speaking/presentation/speaking-grading.controller.ts',
      ),
    ).toBe(true);
    // Identity owns its own restricted edge; metering's double edge is #1576's.
    expect(
      matches(
        businessGatewayRule?.from.path ?? '',
        'src/modules/identity/audit/presentation/audit-cursor.ts',
      ),
    ).toBe(false);
    expect(
      matches(
        businessGatewayRule?.from.path ?? '',
        'src/modules/metering/application/quota-reconciliation.ts',
      ),
    ).toBe(false);
    expect(
      matches(
        businessGatewayRule?.to.path ?? '',
        'src/modules/gateway/application/dispatch/operation-dispatcher.port.ts',
      ),
    ).toBe(true);
  });

  it('narrows the business-to-gateway seams and keeps the rest of gateway private', () => {
    const pathNot = businessGatewayRule?.to.pathNot ?? [];

    expect(
      matches(pathNot, 'src/modules/gateway/public/graded-pipeline.ts'),
    ).toBe(true);
    expect(
      matches(
        pathNot,
        'src/modules/gateway/application/dispatch/operation-dispatcher.port.ts',
      ),
    ).toBe(true);
    // GatewayModule exports RateLimitGuard, so the guard file is seam.
    expect(
      matches(pathNot, 'src/modules/gateway/presentation/rate-limit.guard.ts'),
    ).toBe(true);
    // The GradedRequest decorator composes at import time.
    expect(
      matches(
        pathNot,
        'src/modules/gateway/presentation/graded-request.decorator.ts',
      ),
    ).toBe(true);
    // The composition roots writing.module and speaking.module import.
    expect(matches(pathNot, 'src/modules/gateway/gateway.module.ts')).toBe(
      true,
    );

    // Gateway internals stay private to writing and speaking.
    expect(
      matches(
        pathNot,
        'src/modules/gateway/presentation/graded-pipeline-context.ts',
      ),
    ).toBe(false);
    expect(
      matches(pathNot, 'src/modules/gateway/application/sandbox-admission.ts'),
    ).toBe(false);
  });

  it('keeps avatar free of every gateway import', () => {
    expect(avatarGatewayRule?.severity).toBe('error');
    // No pathNot at all: avatar holds no gateway import today and every one of
    // them, seam or not, is a violation.
    expect(avatarGatewayRule?.to.pathNot).toBeUndefined();
    expect(
      matches(
        avatarGatewayRule?.from.path ?? '',
        'src/modules/avatar/presentation/avatar.controller.ts',
      ),
    ).toBe(true);
    expect(
      matches(
        avatarGatewayRule?.to.path ?? '',
        'src/modules/gateway/gateway.module.ts',
      ),
    ).toBe(true);
    // Only the avatar-to-gateway direction; the general rule still covers the
    // rest of the graph.
    expect(
      matches(
        avatarGatewayRule?.from.path ?? '',
        'src/modules/writing/grading/presentation/writing-grading.controller.ts',
      ),
    ).toBe(false);
  });
});

describe('dependency-cruiser cache policy', () => {
  it('rechecks imports when the rules file changes', () => {
    const projectRoot = workspaceRoot();
    const configPath = join(projectRoot, '.dependency-cruiser.cjs');
    const fixtureRoot = mkdtempSync(
      join(projectRoot, 'src', 'modules', 'identity', '.tmp-policy-cache-'),
    );
    const originalConfig = readFileSync(configPath, 'utf8');
    const changedConfig = originalConfig.replace(
      '  forbidden: [',
      () => `  forbidden: [
    {
      name: 'temporary-policy-cache-check',
      severity: 'error',
      comment: 'temporary policy cache regression fixture',
      from: { path: '^src/modules/identity/[.]tmp-policy-cache-[^/]+/application/probe[.]ts$' },
      to: { path: '^src/modules/identity/domain/organization-name[.]ts$' },
    },`,
    );

    expect(changedConfig).not.toBe(originalConfig);

    try {
      mkdirSync(join(fixtureRoot, 'application'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'application', 'probe.ts'),
        "import { organizationName } from '@/modules/identity/domain/organization-name';\nexport const probe = organizationName('probe');\n",
      );

      expect(spawnArchCheck(projectRoot).status).toBe(0);
      writeFileSync(configPath, changedConfig);
      const result = spawnArchCheck(projectRoot);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'temporary-policy-cache-check',
      );
    } finally {
      writeFileSync(configPath, originalConfig);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
    // Two cruises of the whole tree: the isolated workspace has no
    // dependency-cruiser cache of its own, so the first one starts cold.
  }, 120_000);
});

/**
 * The layer and domain-purity rules belong to dependency-cruiser, which only a
 * run of the whole CLI exercises (about six seconds each). One run covers every
 * case: each fixture sits in its own folder, and a case passes when a reported
 * violation names both its rule and its folder (#1484).
 */
/**
 * The module each fixture folder is created under; every case before #1733
 * predates the field, so it defaults to identity.
 */
type FixtureModule = 'identity' | 'writing' | 'avatar';

interface DependencyRuleCase {
  readonly name: string;
  readonly folder: string;
  readonly rule: string;
  readonly module: FixtureModule;
  readonly files: Readonly<Record<string, string>>;
}

const dependencyRuleCases: ReadonlyArray<DependencyRuleCase> = [
  ...[
    {
      fromLayer: 'application',
      toLayer: 'infrastructure',
      rule: 'application-no-outer-layers',
    },
    {
      fromLayer: 'presentation',
      toLayer: 'infrastructure',
      rule: 'presentation-no-infrastructure',
    },
    {
      fromLayer: 'infrastructure',
      toLayer: 'presentation',
      rule: 'infrastructure-no-presentation',
    },
  ].map(({ fromLayer, toLayer, rule }) => ({
    name: `an import from ${fromLayer} into ${toLayer}`,
    folder: `.tmp-layer-${fromLayer}-${toLayer}`,
    rule,
    module: 'identity' as const,
    files: {
      [`${fromLayer}/probe.ts`]: `import { dependency } from '../${toLayer}/dependency';\nvoid dependency;\n`,
      [`${toLayer}/dependency.ts`]: 'export const dependency = true;\n',
    },
  })),
  ...[
    ['a node: prefixed built-in', "import { domainToASCII } from 'node:url';"],
    ['an unprefixed built-in', "import { readFileSync } from 'fs';"],
  ].map(([name, importLine], index) => ({
    name: `${name} imported into a domain file`,
    folder: `.tmp-domain-purity-${index}`,
    rule: 'domain-no-runtime-modules',
    module: 'identity' as const,
    files: { 'domain/probe.ts': `${importLine}\nexport const probe = 1;\n` },
  })),
  ...[
    {
      name: 'an identity file importing an auth internal file',
      folder: '.tmp-identity-auth-edge',
      rule: 'no-identity-auth-internal-import',
      module: 'identity',
      files: {
        'application/probe.ts':
          "import { PostgresUserAccountRepository } from '@/modules/auth/accounts/infrastructure/postgres-user-account.repository';\nvoid PostgresUserAccountRepository;\n",
      },
    },
    {
      name: 'a writing file importing a gateway internal file',
      folder: '.tmp-writing-gateway-edge',
      rule: 'no-business-to-gateway-internal-import',
      module: 'writing',
      files: {
        'application/probe.ts':
          "import { SandboxAdmission } from '@/modules/gateway/application/sandbox-admission';\nvoid SandboxAdmission;\n",
      },
    },
    {
      name: 'an avatar file importing a gateway seam file',
      folder: '.tmp-avatar-gateway-edge',
      rule: 'no-avatar-gateway-import',
      module: 'avatar',
      files: {
        'application/probe.ts':
          "import { OPERATION_DISPATCHER } from '@/modules/gateway/application/dispatch/operation-dispatcher.port';\nvoid OPERATION_DISPATCHER;\n",
      },
    },
  ].map(({ name, folder, rule, module, files }) => ({
    name,
    folder,
    rule,
    module: module as FixtureModule,
    files,
  })),
];

let dependencyRuleRun: { status: number | null; lines: string[] } | undefined;

function runDependencyRuleCases() {
  if (dependencyRuleRun) return dependencyRuleRun;

  const moduleRoots: Record<FixtureModule, string> = {
    identity: join(workspaceRoot(), 'src', 'modules', 'identity'),
    writing: join(workspaceRoot(), 'src', 'modules', 'writing'),
    avatar: join(workspaceRoot(), 'src', 'modules', 'avatar'),
  };
  try {
    for (const { folder, files, module } of dependencyRuleCases) {
      for (const [file, source] of Object.entries(files)) {
        const target = join(moduleRoots[module], folder, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, source);
      }
    }
    const result = spawnArchCheck();
    dependencyRuleRun = {
      status: result.status,
      lines: `${result.stdout}\n${result.stderr}`.split(/\r?\n/),
    };
  } finally {
    for (const { folder, module } of dependencyRuleCases) {
      rmSync(join(moduleRoots[module], folder), {
        recursive: true,
        force: true,
      });
    }
  }
  return dependencyRuleRun;
}

describe('dependency-cruiser layer and domain purity rules', () => {
  it.each(dependencyRuleCases)(
    'rejects $name',
    ({ folder, rule }) => {
      const run = runDependencyRuleCases();

      expect(run.status).not.toBe(0);
      expect(
        run.lines.some((line) => line.includes(rule) && line.includes(folder)),
      ).toBe(true);
    },
    120_000,
  );
});

/**
 * The rule's own shape is not enough to know it works: dependency-cruiser is
 * what resolves the group placeholder and evaluates the path. This runs the
 * real check over the real tree and pins the count, so a rule that silently
 * stops matching - or starts matching everything - fails instead of waiting
 * for a human to notice the number changed.
 */
describe('cross-module import rule over the real tree', () => {
  let violations: Array<{ from: string; to: string }>;
  let cliViolations: Array<{ from: string; to: string }>;
  let identityAuthViolations: Array<{ from: string; to: string }>;
  let businessGatewayViolations: Array<{ from: string; to: string }>;
  let avatarGatewayViolations: Array<{ from: string; to: string }>;

  beforeAll(() => {
    const result = spawnSync(
      process.execPath,
      [
        join(
          __dirname,
          '..',
          '..',
          'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs',
        ),
        '--config',
        '.dependency-cruiser.cjs',
        '--output-type',
        'json',
        'src',
      ],
      {
        cwd: join(__dirname, '..', '..'),
        encoding: 'utf8',
        // The JSON report for this tree is larger than spawnSync's 1 MiB
        // default, and a truncated report fails to parse rather than assert.
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    const parsedReport: unknown = JSON.parse(result.stdout);
    const reportViolations = parseDependencyCruiserViolations(parsedReport);
    /** @param {string} ruleName */
    const violationsFor = (ruleName: string) =>
      reportViolations
        .filter(({ rule }) => rule.name === ruleName)
        .map((violation: { from: string; to: string }) => ({
          from: violation.from,
          to: violation.to,
        }));
    violations = violationsFor('no-cross-module-internal-import');
    cliViolations = violationsFor('no-cli-module-internal-import');
    identityAuthViolations = violationsFor('no-identity-auth-internal-import');
    businessGatewayViolations = violationsFor(
      'no-business-to-gateway-internal-import',
    );
    avatarGatewayViolations = violationsFor('no-avatar-gateway-import');
  });

  it('reports no imports of another module internal files', () => {
    expect(violations).toEqual([]);
  });

  it('reports no guard, interceptor, or decorator left', () => {
    // What remains is pure functions and module-owned constants, which is the
    // coupling this rule exists to name.
    expect(
      violations.filter(
        (edge) =>
          /[.](guard|interceptor|decorator)[.]ts$/.test(edge.to) ||
          /graded-request/.test(edge.to),
      ),
    ).toEqual([]);
  });

  it('exempts a guard because its module exports it, not because of its folder', () => {
    const pathNot = crossModuleRule?.to.pathNot ?? [];

    // ApiKeyGuard is published by IdentityModule.exports, so the file holding
    // it is seam even though it sits under presentation/.
    expect(
      matches(
        pathNot,
        'src/modules/identity/api-keys/presentation/api-key.guard.ts',
      ),
    ).toBe(true);
    // A file in the same folder that its module does not export stays private,
    // which is what keeps the exemption from widening to the whole directory.
    expect(
      matches(
        pathNot,
        'src/modules/identity/api-keys/presentation/sandbox-api-key.guard.ts',
      ),
    ).toBe(false);
  });

  it('exempts a Nest decorator, which composes at import time and not through DI', () => {
    const pathNot = crossModuleRule?.to.pathNot ?? [];

    // RequireOperation is applied by three modules and no module exports it:
    // it returns SetMetadata, so it can never be a DI provider.
    expect(
      matches(
        pathNot,
        'src/modules/identity/shared/presentation/require-operation.decorator.ts',
      ),
    ).toBe(true);
    expect(
      matches(
        pathNot,
        'src/modules/gateway/presentation/graded-request.decorator.ts',
      ),
    ).toBe(true);
    // A file that is neither exported nor a decorator stays private, which is
    // what keeps the exemption from reaching the owning module's own logic.
    expect(
      matches(
        pathNot,
        'src/modules/metering/application/quota-reconciliation.ts',
      ),
    ).toBe(false);
  });

  it('exempts only explicit public facades, not the implementation behind them', () => {
    const pathNot = crossModuleRule?.to.pathNot ?? [];

    expect(
      matches(pathNot, 'src/modules/metering/public/usage-retention.ts'),
    ).toBe(true);
    expect(
      matches(pathNot, 'src/modules/metering/application/usage-retention.ts'),
    ).toBe(false);
  });

  it('reports none of them from a spec file', () => {
    // Spec files reach into other modules' `testing/` folders on purpose, so
    // dropping the from-side exclusion raises this to 43.
    expect(violations.filter((edge) => edge.from.endsWith('.spec.ts'))).toEqual(
      [],
    );
  });

  it('reports no module importing its own files', () => {
    const selfEdges = violations.filter(
      (edge) => edge.from.split('/')[2] === edge.to.split('/')[2],
    );

    expect(selfEdges).toEqual([]);
  });

  /**
   * `src/cli` is the Operator composition root, so binding infrastructure
   * there is deliberate and must stay unreported. Reaching a module's
   * application logic is not, and that is what the second rule names. Both
   * halves are pinned against the real tree because a carve-out that stops
   * matching fails silently in the direction that hides a real coupling.
   */
  it('reports no command binding infrastructure', () => {
    // Constructing the Postgres client and repository is this tree's job, the
    // same job `*.module.ts` does and that rule also exempts.
    expect(
      cliViolations.filter((edge) => edge.to.includes('/infrastructure/')),
    ).toEqual([]);
  });

  it('reports no command reaching a port', () => {
    // 3 edges today, and every command already injects its repository port.
    expect(
      cliViolations.filter((edge) => edge.to.endsWith('.port.ts')),
    ).toEqual([]);
  });

  it('reports no command importing unpublished application logic', () => {
    expect(cliViolations).toEqual([]);
  });

  it('reports none of them from a cli spec file', () => {
    expect(
      cliViolations.filter((edge) => edge.from.endsWith('.spec.ts')),
    ).toEqual([]);
  });

  it('recognizes published module facades for the CLI boundary too', () => {
    const pathNot = cliRule?.to.pathNot ?? [];

    expect(
      matches(pathNot, 'src/modules/metering/public/usage-retention.ts'),
    ).toBe(true);
    expect(
      matches(pathNot, 'src/modules/metering/application/usage-retention.ts'),
    ).toBe(false);
  });

  it('reads the cli rule from the config', () => {
    // The real-tree assertions above would pass if the rule were silently
    // dropped from the config, so its presence is checked directly.
    expect(cliRule?.severity).toBe('error');
    expect(matches(cliRule?.from.path ?? '', 'src/cli/usage-prune.ts')).toBe(
      true,
    );
    expect(matches(cliRule?.from.path ?? '', 'src/common/foo.ts')).toBe(false);
  });

  /**
   * The restricted edges (#1733) run beside the general rule over the same
   * cruise. Each pinned to silence: the tree today crosses identity→auth and
   * writing/speaking→gateway only through the stated seams, and avatar never
   * reaches gateway, so a violation here means a new import arrived outside
   * them.
   */
  it('reports no identity import of auth outside the stated seams', () => {
    expect(identityAuthViolations).toEqual([]);
  });

  it('reports no writing or speaking import of gateway internals', () => {
    expect(businessGatewayViolations).toEqual([]);
  });

  it('reports no avatar import of gateway code', () => {
    expect(avatarGatewayViolations).toEqual([]);
  });
});

/** Source with comments removed, so prose that mentions the variable does not count as a read. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function commonFilesReadingEnvironment(): string[] {
  const commonDirectory = join(__dirname, '..', '..', 'src', 'common');

  return readdirSync(commonDirectory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts'),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) =>
      /\bprocess\.env\b/.test(withoutComments(readFileSync(file, 'utf8'))),
    )
    .map((file) => relative(commonDirectory, file).split(/[\\/]/).join('/'))
    .sort();
}

/**
 * `.claude/rules/common.md` keeps environment access out of `src/common`;
 * runtime configuration owns reads before Nest starts.
 *
 * This list is the one place that decision is enforced: a new common file that
 * reads `process.env` fails here until it is added to this expectation and to
 * the rule, rather than passing by sitting next to a file that already does.
 * Comparing the whole list also catches the other direction - a boundary
 * adapter that stopped reading anything - which a rule alone would not notice.
 */
describe('common layer environment boundary', () => {
  it('has exactly the boundary adapters that read the environment', () => {
    expect(commonFilesReadingEnvironment()).toEqual([]);
  });
});

/**
 * ADR-0074 gave two modules a reason to name a table the other owns: Identity
 * writes the Email Delivery Request its invitation commits, and Auth reads the
 * invitation to decide whether a claimed request is still actionable. Neither
 * access is an import, so the dependency-cruiser seam cannot see it, and
 * `.claude/rules/testing.md` asks for a guard wherever a new boundary appears.
 *
 * A table listed here is one two modules name. A module that starts naming a
 * table a second module already names fails this until the reason is written
 * down, which is what turns "two modules happen to read the same table" into a
 * decision somebody made. Table names come from the migrations, so an English
 * word in a comment or a CTE name cannot pose as one.
 *
 * A module reaches a table two ways: a SQL statement that names it, and a
 * Prisma model delegate (`transaction.userAccount.create(...)`). The second is
 * resolved to its table through the `@@map` in `schema.prisma`, so moving a
 * statement from SQL to the generated client does not move it out of this guard.
 */
describe('cross-module table access', () => {
  function migrations(): string {
    return join(__dirname, '..', '..', 'prisma', 'migrations');
  }

  function createdTables(): Set<string> {
    const tables = new Set<string>();

    const entries = readdirSync(migrations(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const directory of entries) {
      for (const match of readFileSync(
        join(migrations(), directory, 'migration.sql'),
        'utf8',
      ).matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)) {
        const table = match[1];
        if (table !== undefined) {
          tables.add(table.toLowerCase());
        }
      }
    }

    return tables;
  }

  /** `userAccount` -> `user_accounts`, read from the schema's `@@map`. */
  function delegateTables(): Map<string, string> {
    const schema = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
      'utf8',
    );
    const delegates = new Map<string, string>();
    for (const [, name, body] of schema.matchAll(
      /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm,
    )) {
      const table = body?.match(/@@map\("([a-z_][a-z0-9_]*)"\)/)?.[1];
      if (name !== undefined && table !== undefined) {
        delegates.set(`${name.charAt(0).toLowerCase()}${name.slice(1)}`, table);
      }
    }
    return delegates;
  }

  function moduleInfrastructureFiles(directory: string): string[] {
    return readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.spec.ts'),
      )
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) => file.includes(`${sep}infrastructure${sep}`));
  }

  function sharedTableAccesses(): string[] {
    const tables = createdTables();
    const delegates = delegateTables();
    const modulesByTable = new Map<string, Set<string>>();
    const record = (table: string, module: string): void => {
      const modules = modulesByTable.get(table) ?? new Set<string>();
      modules.add(module);
      modulesByTable.set(table, modules);
    };

    for (const file of moduleInfrastructureFiles(
      join(__dirname, '..', '..', 'src', 'modules'),
    )) {
      const module = relative(
        join(__dirname, '..', '..', 'src', 'modules'),
        file,
      )
        .split(/[\\/]/)
        .join('/')
        .split('/')[0];
      if (module === undefined) {
        continue;
      }

      const source = readFileSync(file, 'utf8');

      for (const [, delegate] of source.matchAll(
        /\.(\w+)\.(?:find\w+|create\w*|update\w*|upsert|delete\w*|count|aggregate|groupBy)\s*[<(]/g,
      )) {
        const table =
          delegate === undefined ? undefined : delegates.get(delegate);
        if (table !== undefined) {
          record(table, module);
        }
      }

      for (const [, statement] of source.matchAll(/`([^`]*)`/g)) {
        if (statement === undefined) {
          continue;
        }
        for (const match of statement.matchAll(
          /\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_][a-z0-9_]*)/gi,
        )) {
          const table = match[1]?.toLowerCase();
          if (table === undefined || !tables.has(table)) {
            continue;
          }
          record(table, module);
        }
      }
    }

    return [...modulesByTable]
      .filter(([, modules]) => modules.size > 1)
      .map(([table, modules]) => `${table}: ${[...modules].sort().join(' + ')}`)
      .sort();
  }

  it('names exactly the tables more than one module reads or writes', () => {
    expect(sharedTableAccesses()).toEqual([
      // ADR-0097: a billing statement leaves keys marked internal off the bill.
      'api_keys: identity + metering',
      // Identity resolves the invitation a request was minted for.
      'auth_identities: auth + identity',
      // ADR-0074: Auth asks whether the credential is still actionable.
      'organization_invitations: auth + identity',
      // Metering reads the Organization an entitlement decision is about.
      'organizations: identity + metering',
      // Writing records the active operator account for #816 revocations.
      'user_accounts: auth + identity + writing',
    ]);
  });
});

/**
 * `parseRequestBody` exists so that a `default` in a TypeBox contract means the
 * same thing on every route. Two ways of reaching TypeBox directly break that:
 * `Value.Check` alone drops the defaults, and `Value.Parse` alone converts
 * before it asserts, so a body of the wrong type decodes instead of failing.
 *
 * Pinning the list of files allowed to do it keeps the rule honest in both
 * directions - a route that starts bypassing the helper fails, and a file that
 * stops bypassing it has to be removed from the list rather than sitting there
 * as a rule that no longer describes anything. The rule allows a call per line,
 * so the same list also has to catch a body check added beside an allowed one,
 * which is why the unmarked-call expectation is asserted separately.
 */
describe('request bodies reach their contract through parseRequestBody', () => {
  const PRESENTATION_ALLOWLIST = [
    'modules/auth/shared/presentation/access-token-envelope.ts',
    'modules/identity/organization-identity-configuration/presentation/organization-identity-config.controller.ts',
    'modules/identity/shared/presentation/organization-id.pipe.ts',
  ];

  const srcRoot = join(__dirname, '..', '..', 'src');

  function presentationFiles(): string[] {
    return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.spec.ts'),
      )
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) => file.includes(`${sep}presentation${sep}`));
  }

  function callsTypeBox(line: string): boolean {
    return /\bValue\.(?:Check|Parse)\s*\(/.test(line);
  }

  // The formatter moves a trailing comment onto its own line, so a marker on
  // the line below a call counts; this mirrors `check-architecture.mjs`.
  function isMarked(lines: string[], index: number): boolean {
    return `${lines[index] ?? ''}\n${lines[index + 1] ?? ''}`.includes(
      'arch-check:',
    );
  }

  function presentationFilesCallingTypeBox(): string[] {
    return presentationFiles()
      .filter((file) => {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        return lines.some(
          (line, index) => callsTypeBox(line) && isMarked(lines, index),
        );
      })
      .map((file) => relative(srcRoot, file).split(/[\\/]/).join('/'))
      .sort();
  }

  function unmarkedTypeBoxCalls(): string[] {
    return presentationFiles()
      .flatMap((file) => {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        return lines.flatMap((line, index) =>
          callsTypeBox(line) && !isMarked(lines, index)
            ? [
                `${relative(srcRoot, file).split(/[\\/]/).join('/')}:${index + 1}`,
              ]
            : [],
        );
      })
      .sort();
  }

  it('allows TypeBox only where the reason is written down', () => {
    expect(presentationFilesCallingTypeBox()).toEqual(PRESENTATION_ALLOWLIST);
  });

  it('has no presentation file validating a body without the reason', () => {
    expect(unmarkedTypeBoxCalls()).toEqual([]);
  });

  it('fails a controller that validates a body itself', () => {
    const result = checkFixtures([
      [
        'src/modules/identity/probe/presentation/probe.controller.ts',
        `import { Value } from '@sinclair/typebox/value';\nexport function probe(body: unknown): boolean {\n  return Value.Check({}, body);\n}\n`,
      ],
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      'route a request body through parseRequestBody',
    );
  });
});

describe('isRecord has one declaration', () => {
  it('fails a file that declares its own', () => {
    const result = checkFixtures([
      [
        'src/modules/identity/probe/infrastructure/probe.ts',
        `function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export const probe = isRecord({});
`,
      ],
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("import it from '@/common/is-record'");
  });
});

describe('the request-id pattern has one declaration', () => {
  function runWithContract(source: string): string {
    return checkFixtures([['src/contracts/probe/probe.ts', source]]).output;
  }

  it('fails a contract that restates the pattern', () => {
    const output = runWithContract(
      `export const probe = { pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$' };\n`,
    );

    expect(output).toContain('restates the request-id pattern');
  });

  it('accepts a restated pattern that says why', () => {
    const output = runWithContract(
      `// arch-check: probe\nexport const probe = { pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$' };\n`,
    );

    expect(output).not.toContain('restates the request-id pattern');
  });
});

describe('a session is stored only with the second-factor check', () => {
  it('fails a file that continues a session without it', () => {
    const result = checkFixtures([
      [
        'src/modules/auth/probe/infrastructure/probe.ts',
        `import { admitSessionContinuation } from '@/modules/auth/shared/infrastructure/auth-mfa-session.guard';\nexport const admission = admitSessionContinuation('usr_1');\n`,
      ],
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      'only the Refresh Token rotation may continue a session',
    );
  });
});

describe('query parameters reach parseRequestQuery at the controller boundary', () => {
  function withControllerFixture(
    source: string,
    assertion: (result: ReturnType<typeof checkFixtures>) => void,
  ): void {
    assertion(
      checkFixtures([
        ['src/modules/identity/probe/presentation/probe.controller.ts', source],
      ]),
    );
  }

  it('fails a controller that reads request.query outside the helper', () => {
    withControllerFixture(
      `export class ProbeController {\n  list(request: { query: unknown }) {\n    return request.query;\n  }\n}\n`,
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.output).toContain('parseRequestQuery');
      },
    );
  });

  it('fails a controller that reads a named @Query parameter', () => {
    withControllerFixture(
      `export class ProbeController {\n  list(@Query('part') part: unknown) {\n    return part;\n  }\n}\n`,
      (result) => {
        expect(result.status).not.toBe(0);
        expect(result.output).toContain('parseRequestQuery');
      },
    );
  });

  it('allows whole-query validation and an explicit per-access reason', () => {
    withControllerFixture(
      `export class ProbeController {\n  list(request: { query: unknown }) {\n    return parseRequestQuery(schema, request.query);\n  }\n\n  injected(@Query() query: unknown) {\n    return parseRequestQuery(schema, query);\n  }\n\n  named(@Query('part') part: unknown) { // arch-check: upstream validates this single field\n    return part;\n  }\n}\n`,
      (result) => {
        expect(result.status).toBe(0);
      },
    );
  });
});

describe('the generated Prisma client stays inside infrastructure', () => {
  const importClient = (typeAnnotation: string) =>
    `import ${typeAnnotation} from '@prisma-client/client';\n\nexport type Probe = PrismaClient;\n`;

  it('fails an application file that imports the generated client', () => {
    const { status, output } = checkFixtures([
      [
        'src/modules/identity/probe/application/probe.use-case.ts',
        importClient('{ PrismaClient }'),
      ],
    ]);

    expect(status).not.toBe(0);
    expect(output).toContain('only infrastructure may');
  });

  it('fails an application file of the persistence module itself', () => {
    const { status, output } = checkFixtures([
      [
        'src/modules/persistence/probe/application/probe.port.ts',
        importClient('type { PrismaClient }'),
      ],
    ]);

    expect(status).not.toBe(0);
    expect(output).toContain('only infrastructure may');
  });

  it('fails a dynamic import of the generated client outside infrastructure', () => {
    const { status, output } = checkFixtures([
      [
        'src/modules/identity/probe/application/probe.use-case.ts',
        `export async function probe(): Promise<unknown> {\n  return import('@prisma-client/client');\n}\n`,
      ],
    ]);

    expect(status).not.toBe(0);
    expect(output).toContain('only infrastructure may');
  });

  it('accepts the same import inside infrastructure', () => {
    const { status, output } = checkFixtures([
      [
        'src/modules/identity/probe/infrastructure/probe.repository.ts',
        importClient('{ PrismaClient }'),
      ],
    ]);

    expect(output).not.toContain('only infrastructure may');
    expect(status).toBe(0);
  });
});

describe('the Kysely evaluation stays inside infrastructure', () => {
  it('fails an application file that imports Kysely', () => {
    const { status, output } = checkFixtures([
      [
        'src/modules/metering/probe/application/probe.use-case.ts',
        `import { Kysely } from 'kysely';\n\nexport type Probe = Kysely<unknown>;\n`,
      ],
    ]);

    expect(status).not.toBe(0);
    expect(output).toContain('imports Kysely outside infrastructure');
  });

  it('fails an application file that imports generated Kysely types', () => {
    const { status, output } = checkFixtures([
      [
        'src/modules/metering/probe/application/probe.port.ts',
        `import type { DB } from '@kysely-types/types';\n\nexport type Probe = DB;\n`,
      ],
    ]);

    expect(status).not.toBe(0);
    expect(output).toContain('imports Kysely outside infrastructure');
  });
});

describe('source-text architecture rules fail arch-check', () => {
  /**
   * `fixtureDirectory` is relative to the repository root. The files live only
   * in memory (#1484), under a fixture folder so that a layer segment such as
   * `infrastructure` still decides which rules apply to them.
   */
  function runWithFixtures(
    fixtures: Array<{ layer: string; name: string; source: string }>,
    fixtureDirectory = 'src/modules/identity',
  ): { status: number | null; output: string } {
    const { status, output } = checkFixtures(
      fixtures.map(({ layer, name, source }) => [
        join(fixtureDirectory, '.tmp-source-text-fixture', layer, name),
        source,
      ]),
    );

    return { status, output };
  }

  function rawSqlProbe(source: string): {
    status: number | null;
    output: string;
  } {
    return runWithFixtures([
      { layer: 'infrastructure', name: 'raw-sql.repository.ts', source },
    ]);
  }

  it.each([
    'client.$queryRawUnsafe(`SELECT * FROM records WHERE id = ${request.id}`);\n',
    "const query = prefix + request.sql;\nclient['$executeRawUnsafe'](query);\n",
  ])('rejects dynamic SQL passed to Prisma unsafe APIs: %s', (source) => {
    const result = rawSqlProbe(source);

    expect(result.output).toContain('passes dynamic SQL to');
    expect(result.status).not.toBe(0);
  });

  it.each([
    'const { $queryRawUnsafe } = client;\n',
    'const run = client.$executeRawUnsafe.bind(client);\n',
    "client['$queryRawUnsafe'].call(client, request.sql);\n",
  ])('rejects an unsafe API used without a direct call: %s', (source) => {
    const result = rawSqlProbe(source);

    expect(result.output).toContain('without calling it');
    expect(result.status).not.toBe(0);
  });

  it('allows a referenced unsafe API that carries an arch-check reason', () => {
    const result = rawSqlProbe(
      [
        '// arch-check: proxy forwards to the guarded wrapper',
        'const run = client.$executeRawUnsafe.bind(client);',
        '',
      ].join('\n'),
    );

    expect(result.output).not.toContain('without calling it');
    expect(result.status).toBe(0);
  });

  it('allows SQL built from an allowlisted fragment builder', () => {
    const result = runWithFixtures([
      {
        layer: 'infrastructure',
        name: 'billable-request-sql.ts',
        source:
          'export function billableRequestSql(alias = ""): string { return alias; }\n',
      },
      {
        layer: 'infrastructure',
        name: 'raw-sql.repository.ts',
        source: [
          "import { billableRequestSql } from './billable-request-sql';",
          'const COUNT_SQL = `SELECT COUNT(*) FROM usage_records u WHERE ${billableRequestSql("u")}`;',
          'export const count = (client: any) => client.$queryRawUnsafe(COUNT_SQL);',
          '',
        ].join('\n'),
      },
    ]);

    expect(result.output).not.toContain('passes dynamic SQL to');
    expect(result.status).toBe(0);
  });

  it.each([
    // same name from a module that is not on the allowlist
    "import { billableRequestSql } from './other-sql';\nconst S = `SELECT 1 WHERE ${billableRequestSql()}`;\nclient.$queryRawUnsafe(S);\n",
    // allowlisted builder fed a request value
    "import { billableRequestSql } from './billable-request-sql';\nclient.$queryRawUnsafe(`SELECT 1 WHERE ${billableRequestSql(request.alias)}`);\n",
    // a sort column taken from the request, not from the allowlist
    "import { billableRequestSql } from './billable-request-sql';\nclient.$queryRawUnsafe(`SELECT 1 ORDER BY ${request.sort}`);\n",
  ])('rejects a fragment that is not allowlisted: %s', (source) => {
    const result = rawSqlProbe(source);

    expect(result.output).toContain('passes dynamic SQL to');
    expect(result.status).not.toBe(0);
  });

  it('allows static SQL with bound values', () => {
    const result = rawSqlProbe(
      "client.$queryRawUnsafe('SELECT * FROM records WHERE id = $1', request.id);\n",
    );

    expect(result.output).not.toContain('passes dynamic SQL to');
    expect(result.status).toBe(0);
  });

  it('allows module-level static SQL constants inside functions', () => {
    const result = rawSqlProbe(
      [
        "const INSERT_SQL = 'INSERT INTO records (id) VALUES ($1)';",
        'function insert(client: any, id: string) {',
        '  return client.$queryRawUnsafe(INSERT_SQL, id);',
        '}',
        '',
      ].join('\n'),
    );

    expect(result.output).not.toContain('passes dynamic SQL to');
    expect(result.status).toBe(0);
  });

  it('requires an explicit arch-check reason for dynamic SQL wrappers', () => {
    const result = rawSqlProbe(
      [
        'function execute(client: any, sql: string) {',
        '  // arch-check: wrapper accepts reviewed SQL and bound values only',
        '  client.$executeRawUnsafe(sql);',
        '}',
        '',
      ].join('\n'),
    );

    expect(result.output).not.toContain('passes dynamic SQL to');
    expect(result.status).toBe(0);
  });

  it('rejects host literals in downstream source files', () => {
    const result = runWithFixtures(
      [
        {
          layer: '.',
          name: 'probe.ts',
          source: "export const endpoint = 'https://api.example.test';\n",
        },
      ],
      'src/downstream',
    );

    expect(result.output).toContain('contains a host literal');
    expect(result.status).not.toBe(0);
  });

  function downstreamProbe(source: string): {
    status: number | null;
    output: string;
  } {
    return runWithFixtures(
      [{ layer: '.', name: 'probe.ts', source }],
      'src/downstream',
    );
  }

  it.each([
    ["import { request } from 'node:https';\nexport const send = request;\n"],
    ["import axios from 'axios';\nexport const send = axios;\n"],
    ['export const send = (path: string) => fetch(path);\n'],
    ["export const http = require('node:http');\n"],
    ["export const load = () => import('undici');\n"],
  ])(
    'rejects network I/O in a downstream adapter: %s',
    (source) => {
      const result = downstreamProbe(source);

      expect(result.output).toContain('network client');
      expect(result.status).not.toBe(0);
    },
    30_000,
  );

  it.each([
    ["import { Client } from 'pg';\nexport const db = Client;\n"],
    ["import Redis from 'ioredis';\nexport const cache = Redis;\n"],
    [
      "import { S3Client } from '@aws-sdk/client-s3';\nexport const store = S3Client;\n",
    ],
    [
      "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n",
    ],
    [
      "import type { PrismaClient } from '@prisma-client/client';\nexport type Db = PrismaClient;\n",
    ],
    [
      "import { PERSISTENCE } from '@/modules/persistence/public/tokens';\nexport const token = PERSISTENCE;\n",
    ],
    [
      "import { repository } from '@/modules/identity/membership/infrastructure/repository';\nexport const reader = repository;\n",
    ],
  ])(
    'rejects persistence or storage in a downstream adapter: %s',
    (source) => {
      const result = downstreamProbe(source);

      expect(result.output).toContain('persistence or storage');
      expect(result.status).not.toBe(0);
    },
    30_000,
  );

  it.each([
    ['export const mode = process.env.NODE_ENV;\n'],
    ["export const mode = process['env'].NODE_ENV;\n"],
    ['const { env } = process;\nexport const mode = env.NODE_ENV;\n'],
    ['export const mode = import.meta.env.NODE_ENV;\n'],
    [
      "import { ConfigService } from '@nestjs/config';\nexport const c = ConfigService;\n",
    ],
    [
      "import { appConfig } from '@/config/runtime-configuration';\nexport const c = appConfig;\n",
    ],
  ])(
    'rejects environment access in a downstream adapter: %s',
    (source) => {
      const result = downstreamProbe(source);

      expect(result.output).toContain('the environment');
      expect(result.status).not.toBe(0);
    },
    30_000,
  );

  it.each([
    ['export const note = (message: string) => console.log(message);\n'],
    ['export const note = (error: unknown) => console.error(error);\n'],
    [
      "import { Logger } from '@nestjs/common';\nexport const log = new Logger('x');\n",
    ],
    ["import pino from 'pino';\nexport const log = pino();\n"],
    ['export const note = (text: string) => process.stdout.write(text);\n'],
  ])(
    'rejects direct logging in a downstream adapter: %s',
    (source) => {
      const result = downstreamProbe(source);

      expect(result.output).toContain('logging');
      expect(result.status).not.toBe(0);
    },
    30_000,
  );

  it('accepts a pure mapper that only imports contracts and maps data', () => {
    const result = downstreamProbe(
      [
        "import { createHash } from 'node:crypto';",
        "import { Buffer } from 'node:buffer';",
        "import { isRecord } from '@/common/is-record';",
        "import { contractViolation } from '../contract-violation';",
        'export function map(value: unknown): string {',
        '  if (!isRecord(value)) throw contractViolation();',
        "  return createHash('sha256').update(Buffer.from(JSON.stringify(value))).digest('hex');",
        '}',
        '',
      ].join('\n'),
    );

    expect(result.output).not.toContain('pure mapper');
  }, 60_000);

  it('rejects process, PostgreSQL pool, and Vault access outside their boundaries', () => {
    const result = runWithFixtures([
      {
        layer: 'infrastructure',
        name: 'environment.ts',
        source: 'export const environment = process.env.NODE_ENV;\n',
      },
      {
        layer: 'infrastructure',
        name: 'pool.ts',
        source: "import { Pool } from 'pg';\nexport const pool = new Pool();\n",
      },
      {
        layer: 'infrastructure',
        name: 'vault.ts',
        source: "export const provider = 'vault';\n",
      },
    ]);

    expect(result.output).toContain('outside the configuration boundary');
    expect(result.output).toContain('constructs a PostgreSQL pool directly');
    expect(result.output).toContain('Vault-specific infrastructure');
    expect(result.status).not.toBe(0);
  });

  it('keeps package-manager child processes rejected outside the #225 benchmark', () => {
    const packageManager = ['p', 'npm'].join('');
    const result = runWithFixtures(
      [
        {
          layer: 'ops',
          name: 'probe.mjs',
          source: `spawn('${packageManager}', ['dev']);\n`,
        },
      ],
      'scripts',
    );

    expect(result.output).toContain('spawns pnpm');
    expect(result.status).not.toBe(0);
  });

  it('allows environment reads and Vault references in their boundary folders', () => {
    const configuration = runWithFixtures(
      [
        {
          layer: '.',
          name: 'probe.ts',
          source: 'export const environment = process.env.NODE_ENV;\n',
        },
      ],
      'src/config',
    );
    const secrets = runWithFixtures(
      [
        {
          layer: '.',
          name: 'probe.ts',
          source: "export const provider = 'vault';\n",
        },
      ],
      'src/modules/secrets/infrastructure',
    );

    expect(configuration.status).toBe(0);
    expect(secrets.status).toBe(0);
  });

  it("fails when an application file declares module 'fastify'", () => {
    const result = runWithFixtures([
      {
        layer: 'application',
        name: 'probe.ts',
        source: "declare module 'fastify' {}\n",
      },
    ]);

    expect(result.output).toContain("declares module 'fastify'");
    expect(result.status).not.toBe(0);
  }, 30_000);

  it('fails when infrastructure casts an application-declared type', () => {
    const result = runWithFixtures([
      {
        layer: 'application',
        name: 'probe.port.ts',
        source: 'export type ProbeApplicationType = {};\n',
      },
      {
        layer: 'infrastructure',
        name: 'probe.adapter.ts',
        source: 'const probe = {} as unknown as ProbeApplicationType;\n',
      },
    ]);

    expect(result.output).toContain('casts an application-declared type');
    expect(result.status).not.toBe(0);
  }, 30_000);
});

describe('Nest module import cycles (#1576)', () => {
  const moduleFile = (owner: string, imported: string): string =>
    `import { ${imported}Module } from '@/modules/${imported}/${imported}.module';\nimport { ${owner}Module } from './${owner}.module';\nexport class ${owner}Module {}\n`;
  const cycleFixture = (owner: string, imported: string): [string, string] => [
    `src/modules/${owner}/${owner}.module.ts`,
    moduleFile(owner, imported),
  ];

  it('fails on a direct cycle between two modules, naming both', () => {
    const result = checkFixtures([
      cycleFixture('gateway', 'metering'),
      cycleFixture('metering', 'gateway'),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('Nest module import cycle');
    expect(result.output).toContain('gateway -> metering -> gateway');
  });

  it('fails on a cycle through a third module, naming every module in it', () => {
    const result = checkFixtures([
      cycleFixture('identity', 'gateway'),
      cycleFixture('gateway', 'metering'),
      cycleFixture('metering', 'identity'),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      'identity -> gateway -> metering -> identity',
    );
  });

  it('stays silent on an acyclic module import graph', () => {
    const result = checkFixtures([
      cycleFixture('gateway', 'metering'),
      cycleFixture('identity', 'gateway'),
    ]);

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('Nest module import cycle');
  });

  it('fails on a cycle reached through a public/ re-export of a module', () => {
    const result = checkFixtures([
      [
        'src/modules/writing/writing.module.ts',
        `import { DispatchAttemptModule } from '@/modules/metering/public/dispatch-attempts';\nexport class WritingModule {}\n`,
      ],
      [
        'src/modules/metering/public/dispatch-attempts.ts',
        `export { DispatchAttemptModule } from '@/modules/metering/dispatch-attempt.module';\n`,
      ],
      [
        'src/modules/metering/dispatch-attempt.module.ts',
        `export class DispatchAttemptModule {}\n`,
      ],
      cycleFixture('metering', 'writing'),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('Nest module import cycle');
    expect(result.output).toContain('writing -> metering -> writing');
  });

  it('ignores import type edges', () => {
    const result = checkFixtures([
      [
        'src/modules/gateway/gateway.module.ts',
        `import type { MeteringModule } from '@/modules/metering/metering.module';\nexport class GatewayModule {}\n`,
      ],
      cycleFixture('metering', 'gateway'),
    ]);

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('Nest module import cycle');
  });

  it('detects a relative ../other/x.module import across owners', () => {
    const result = checkFixtures([
      [
        'src/modules/gateway/sub/gateway-sub.module.ts',
        `import { MeteringModule } from '../../metering/metering.module';\nexport class GatewaySubModule {}\n`,
      ],
      cycleFixture('metering', 'gateway'),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('Nest module import cycle');
    expect(result.output).toContain('gateway');
    expect(result.output).toContain('metering');
  });

  it('ignores a module importing its own module', () => {
    const result = checkFixtures([
      [
        'src/modules/gateway/gateway.module.ts',
        `import { GatewayModule } from './gateway.module';\nexport class GatewayModule {}\n`,
      ],
    ]);

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('Nest module import cycle');
  });
});

describe('collectSourceTextFailures and the CLI agree (#1484)', () => {
  it('finds no source-text failure in the real tree', () => {
    expect(collectSourceTextFailures({ root: repoRoot })).toEqual({
      failures: [],
      stoppedEarly: false,
    });
  });

  it('stops after the first group of rules, as the CLI always did', () => {
    const firstGroup = checkFixtures([
      [
        'src/modules/identity/probe/infrastructure/probe.ts',
        'export const isRecord = (value: unknown) => value !== null;\n',
      ],
    ]);
    const secondGroupOnly = collectSourceTextFailures({
      root: repoRoot,
      files: [join(repoRoot, 'src/modules/identity/probe/application/p.ts')],
      readSource: () => "declare module 'fastify' {}\n",
    });

    expect(firstGroup.failures).toHaveLength(1);
    expect(secondGroupOnly.failures).toHaveLength(1);
    expect(secondGroupOnly.stoppedEarly).toBe(false);
    expect(
      collectSourceTextFailures({
        root: repoRoot,
        files: [
          join(repoRoot, 'src/modules/identity/probe/infrastructure/p.ts'),
        ],
        readSource: () => 'export const isRecord = () => true;\n',
      }).stoppedEarly,
    ).toBe(true);
  });

  it('exits 1 with the message and skips dependency-cruiser on a failure', () => {
    const fixtureRoot = join(
      workspaceRoot(),
      'src',
      'modules',
      'identity',
      '.tmp-cli-smoke',
    );
    try {
      mkdirSync(join(fixtureRoot, 'infrastructure'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'infrastructure', 'probe.ts'),
        'export const isRecord = () => true;\n',
      );

      const result = spawnArchCheck();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Architecture check failed: ');
      expect(result.stderr).toContain('probe.ts:1 declares its own isRecord');
      expect(result.stdout).not.toContain('dependency violations');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * Declared last, so it sees what every fixture above left behind. It also
 * catches a probe directory from an earlier run that was killed mid-test.
 */
describe('fixture isolation (#1636)', () => {
  it('leaves no fixture directory in the real source tree', () => {
    const leftovers = readdirSync(join(repoRoot, 'src'), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.tmp-'))
      .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)));

    expect(leftovers).toEqual([]);
  });
});
