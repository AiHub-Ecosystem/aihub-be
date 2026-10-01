import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import architectureConfig from '../.dependency-cruiser.cjs';

type DependencyCruiserConfig = typeof architectureConfig;

const rules =
  architectureConfig.forbidden as DependencyCruiserConfig['forbidden'];
const crossModuleRule = rules.find(
  (rule) => rule.name === 'no-cross-module-internal-import',
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
  });

  it('reports the 15 cross-module imports ADR-0066 records', () => {
    // Six of the 21 the rule reported before Nest exports were recognised are
    // the graded-request chain composing guards its owning modules export.
    expect(violations).toHaveLength(15);
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
});
