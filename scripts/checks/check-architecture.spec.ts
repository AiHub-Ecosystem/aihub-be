import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import architectureConfig from '../../.dependency-cruiser.cjs';

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
      matches(pathNot, 'src/modules/gateway/presentation/quota.guard.ts'),
    ).toBe(true);
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
  });

  it('excludes spec files from the importing side', () => {
    expect(crossModuleRule?.from.pathNot).toBe('[.]spec[.]ts$');
  });
});

describe('layer rules on feature-first Identity paths', () => {
  it.each([
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
  ])(
    'rejects an import from $fromLayer into $toLayer',
    ({ fromLayer, toLayer, rule }) => {
      const fixtureRoot = mkdtempSync(
        join(tmpdir(), 'aihub-identity-architecture-'),
      );
      const featureRoot = join(
        fixtureRoot,
        'src',
        'modules',
        'identity',
        'architecture-fixture',
      );
      const sourceFile = join(featureRoot, fromLayer, 'probe.ts');
      const dependencyFile = join(featureRoot, toLayer, 'dependency.ts');

      try {
        mkdirSync(join(featureRoot, fromLayer), { recursive: true });
        mkdirSync(join(featureRoot, toLayer), { recursive: true });
        writeFileSync(
          sourceFile,
          `import { dependency } from '../${toLayer}/dependency';\nvoid dependency;\n`,
        );
        writeFileSync(dependencyFile, 'export const dependency = true;\n');
        writeFileSync(
          join(fixtureRoot, 'tsconfig.json'),
          JSON.stringify({ compilerOptions: { target: 'ES2022' } }),
        );

        const result = spawnSync(
          process.execPath,
          [
            join(
              process.cwd(),
              'node_modules',
              'dependency-cruiser',
              'bin',
              'dependency-cruiser.mjs',
            ),
            '--config',
            join(process.cwd(), '.dependency-cruiser.cjs'),
            '--output-type',
            'err-long',
            'src',
          ],
          {
            cwd: fixtureRoot,
            encoding: 'utf8',
          },
        );

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(rule);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
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
        cwd: join(__dirname, '..', '..'),
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
 */
describe('cross-module table access', () => {
  function migrations(): string {
    return join(__dirname, '..', '..', 'database', 'migrations');
  }

  function createdTables(): Set<string> {
    const tables = new Set<string>();

    for (const file of readdirSync(migrations()).filter((entry) =>
      entry.endsWith('.sql'),
    )) {
      for (const match of readFileSync(
        join(migrations(), file),
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
    const modulesByTable = new Map<string, Set<string>>();

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

      for (const [, statement] of readFileSync(file, 'utf8').matchAll(
        /`([^`]*)`/g,
      )) {
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
          const modules = modulesByTable.get(table) ?? new Set<string>();
          modules.add(module);
          modulesByTable.set(table, modules);
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
      // Identity resolves the invitation a request was minted for.
      'auth_identities: auth + identity',
      // ADR-0074: Auth asks whether the credential is still actionable.
      'organization_invitations: auth + identity',
      // Metering reads the Organization an entitlement decision is about.
      'organizations: identity + metering',
      // Both modules resolve the User Account a token belongs to.
      'user_accounts: auth + identity',
    ]);
  });
});
