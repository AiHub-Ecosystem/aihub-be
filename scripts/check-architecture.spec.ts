import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import architectureConfig from '../.dependency-cruiser.cjs';

type DependencyCruiserConfig = typeof architectureConfig;

const rules =
  architectureConfig.forbidden as DependencyCruiserConfig['forbidden'];
const crossModuleRule = rules.find(
  (rule) => rule.name === 'no-cross-module-internal-import',
);
const cliRule = rules.find(
  (rule) => rule.name === 'no-cli-module-internal-import',
);

function matches(pattern: string | string[], path: string): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((entry) => new RegExp(entry).test(path));
}

/**
 * The rule matches any module on the `to` side and exempts the seam through
 * `to.pathNot`. Getting that wrong is silent in both directions: a `pathNot`
 * that stops matching reports nothing at all, and a `pathNot` that keeps
 * matching reports the whole tree. The real-tree test at the bottom is what
 * pins the effect; these cases pin which paths the rule reads as seam.
 */
describe('cross-module import rule', () => {
  it('is reported rather than enforced until it can read a Nest exports array', () => {
    // ADR-0066: the graded-request chain composes guards that their owning
    // module exports, so forbidding this rule would reject a deliberate
    // construction until the rule can tell an export from a private file.
    expect(crossModuleRule?.severity).toBe('warn');
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
        'src/modules/identity/presentation/audit-cursor.ts',
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
      matches(pathNot, 'src/modules/gateway/presentation/quota.guard.ts'),
    ).toBe(true);
  });

  it('treats a file declaring module fastify as shared, read from source', () => {
    const pathNot = crossModuleRule?.to.pathNot ?? [];

    expect(
      matches(
        pathNot,
        'src/modules/identity/presentation/authenticated-request.ts',
      ),
    ).toBe(true);
    // The same presentation folder holds files that do not declare it.
    expect(
      matches(pathNot, 'src/modules/identity/presentation/audit-cursor.ts'),
    ).toBe(false);
  });

  it('excludes spec files from the importing side', () => {
    expect(crossModuleRule?.from.pathNot).toBe('[.]spec[.]ts$');
  });
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

  beforeAll(() => {
    const result = spawnSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      [
        'exec',
        'depcruise',
        '--config',
        '.dependency-cruiser.cjs',
        '--output-type',
        'json',
        'src',
      ],
      {
        cwd: join(__dirname, '..'),
        encoding: 'utf8',
        shell: true,
        // The JSON report for this tree is larger than spawnSync's 1 MiB
        // default, and a truncated report fails to parse rather than assert.
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    const report = JSON.parse(result.stdout);
    violations = report.summary.violations
      .filter(
        (violation: { rule: { name: string } }) =>
          violation.rule.name === 'no-cross-module-internal-import',
      )
      .map((violation: { from: string; to: string }) => ({
        from: violation.from,
        to: violation.to,
      }));
    cliViolations = report.summary.violations
      .filter(
        (violation: { rule: { name: string } }) =>
          violation.rule.name === 'no-cli-module-internal-import',
      )
      .map((violation: { from: string; to: string }) => ({
        from: violation.from,
        to: violation.to,
      }));
  });

  it('reports the 11 cross-module imports ADR-0066 records', () => {
    // Ten of the 21 the rule first reported are seam: six the graded-request
    // chain composes from a module's `exports:`, and four decorator files that
    // compose at import time and can never travel through DI.
    expect(violations).toHaveLength(11);
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
      matches(pathNot, 'src/modules/identity/presentation/api-key.guard.ts'),
    ).toBe(true);
    // A file in the same folder that its module does not export stays private,
    // which is what keeps the exemption from widening to the whole directory.
    expect(
      matches(
        pathNot,
        'src/modules/identity/presentation/sandbox-api-key.guard.ts',
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
        'src/modules/identity/presentation/require-operation.decorator.ts',
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
    // 14 edges today. Constructing the Postgres client and repository is this
    // tree's job, the same job `*.module.ts` does and that rule also exempts.
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

  it('reports the 4 commands using module logic as a library', () => {
    // No module wires these services, so nothing publishes them and a command
    // is free to drift from the rule the module owns. Publishing them is the
    // fix, and it changes code rather than the rule.
    expect(cliViolations).toHaveLength(4);
    expect(
      [
        ...new Set(cliViolations.map((edge) => edge.to.split('/').pop())),
      ].sort(),
    ).toEqual([
      'quota-reconciliation.ts',
      'usage-completeness-report.ts',
      'usage-retention.ts',
    ]);
  });

  it('reports none of them from a cli spec file', () => {
    expect(
      cliViolations.filter((edge) => edge.from.endsWith('.spec.ts')),
    ).toEqual([]);
  });

  it('leaves the module-to-module count untouched', () => {
    // Both rules read the same seam helpers, so changing what counts as
    // published moves both counts. This pins that adding the second rule did
    // not widen the first.
    expect(violations).toHaveLength(11);
  });

  it('reads the cli rule from the config', () => {
    // The real-tree assertions above would pass if the rule were silently
    // dropped from the config, so its presence is checked directly.
    expect(cliRule?.severity).toBe('warn');
    expect(matches(cliRule?.from.path ?? '', 'src/cli/usage-prune.ts')).toBe(
      true,
    );
    expect(matches(cliRule?.from.path ?? '', 'src/common/foo.ts')).toBe(false);
  });
});

function commonFilesReadingEnvironment(): string[] {
  const commonDirectory = join(__dirname, '..', 'src', 'common');

  return readdirSync(commonDirectory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts'),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => /\bprocess\.env\b/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(commonDirectory, file).split(/[\\/]/).join('/'))
    .sort();
}

/**
 * `.claude/rules/common.md` lets a file under `src/common` read the
 * environment only when it is an explicit boundary adapter, and
 * `check-architecture.mjs` fails the build for one that is not on its list.
 *
 * That list is the decision, so it is pinned here too: a new common file that
 * reads `process.env` has to add a visible line to the rule and to this
 * expectation, rather than pass by sitting next to a file that already does.
 * Comparing the whole list also catches the other direction - a boundary
 * adapter that stopped reading anything - which a rule alone would not notice.
 */
describe('common layer environment boundary', () => {
  it('has exactly the boundary adapters that read the environment', () => {
    expect(commonFilesReadingEnvironment()).toEqual([
      'observability/open-telemetry.ts',
      'observability/request-logger.ts',
    ]);
  });
});
