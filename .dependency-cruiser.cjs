const { readdirSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');
const process = require('node:process');

const modulesDirectory = join(__dirname, 'src', 'modules');

/**
 * Reading file contents is deliberate: a guard or decorator is a Nest object
 * owned by its module, not a shared primitive, so matching on its shape would
 * silently exempt every internal guard too. Declaring `module 'fastify'` is the
 * one signal that says "this file extends the shared request contract", and a
 * file that does not say it stays private by default.
 */
function isSharedPrimitive(file) {
  return /declare module ['"]fastify['"]/.test(readFileSync(file, 'utf8'));
}

/**
 * A business module reaches another through its public seam and nothing else.
 * The seam is three things (ADR-0066):
 *
 *   1. `<module>.module.ts`, which is Nest composition wiring.
 *   2. `application/**\/*.port.ts`, an application port the owner declares.
 *   3. A presentation primitive that declares `module 'fastify'`, because it
 *      extends the shared request type every module already agrees on.
 *
 * `from.path` captures the module name as group 1 and `to.path` refers back to
 * it as `$1` inside a negative lookahead, so one rule expresses "any module to
 * a different module" without generating a rule per module pair.
 *
 * This rule is `warn`, not `error`, and it reports 21 violations that are not
 * all mistakes. NestJS already provides a public seam through each module's
 * `exports:` - `ApiKeyGuard`, `UserIdentityGuard`, `UserAccessJwtGuard`,
 * `RateLimitGuard` and `QuotaGuard` are all exported by their owning module and
 * consumed by the graded-request chain that ADR-0057 declares a contract. A
 * path-based rule cannot see a Nest `exports:` array, so it cannot tell that
 * seam from reaching into internals. Until the rule can recognise Nest DI
 * exports, enabling it as an error would reject the graded-request chain this
 * repository deliberately built.
 */
function crossModuleRule() {
  return {
    name: 'no-cross-module-internal-import',
    severity: 'warn',
    comment:
      "A business module depends on another through its public seam: the module file, an application port, or a primitive that declares 'module fastify'. Importing another module's internals couples two modules that must be able to change apart. Reported as a warning because Nest module 'exports:' arrays are a real seam this path-based rule cannot see yet (ADR-0066).",
    from: {
      // Group 1 is the importing module's name.
      path: '^src/modules/([^/]+)/',
      pathNot: '[.]spec[.]ts$',
    },
    to: {
      path: '^src/modules/(?!$1/)[^/]+/',
      pathNot: [
        '^src/modules/[^/]+/[^/]+[.]module[.]ts$',
        '^src/modules/[^/]+/application/[^/]*[.]port[.]ts$',
        ...sharedPrimitivePaths(),
      ],
    },
  };
}

/**
 * A presentation primitive that declares `module 'fastify'` extends the shared
 * request type, so it is part of the seam rather than the owning module's
 * internals. The paths are read from source instead of listed here, so a file
 * that does not declare it stays private and a new file needs no edit to this
 * config to become shared.
 */
function sharedPrimitivePaths() {
  return readdirSync(modulesDirectory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts') &&
        isSharedPrimitive(join(entry.parentPath, entry.name)),
    )
    .map(
      (entry) =>
        // depcruise matches these against paths relative to the cruise root,
        // so an absolute path from readdirSync would never match.
        `^${relative(process.cwd(), join(entry.parentPath, entry.name))
          .split(/[\\/]/)
          .join('/')
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    );
}

module.exports = {
  // no-orphans is intentionally omitted; orphan/liveness analysis belongs to
  // dedicated tooling and may overlap with Knip.
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular imports can evaluate modules in an order that leaves dependencies undefined at runtime.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'Unresolvable imports make the composition graph incomplete and fail outside narrow unit-test paths.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'domain-no-outer-layers',
      severity: 'error',
      comment:
        'Domain code must not depend on application, infrastructure, or presentation.',
      from: { path: '^src/.*/domain/' },
      to: { path: '^src/.*/(application|infrastructure|presentation)/' },
    },
    {
      name: 'domain-no-framework-or-io',
      severity: 'error',
      comment: 'Domain code is framework-free and side-effect-free.',
      from: { path: '^src/.*/domain/' },
      to: { path: 'node_modules' },
    },
    {
      name: 'application-no-outer-layers',
      severity: 'error',
      comment:
        'Application code depends on domain and ports, not concrete outer layers.',
      from: { path: '^src/.*/application/' },
      to: { path: '^src/.*/(infrastructure|presentation)/' },
    },
    {
      name: 'presentation-no-infrastructure',
      severity: 'error',
      comment:
        'Controllers and presentation code call application ports, not adapters.',
      from: { path: '^src/.*[.]controller[.]ts$|^src/.*/presentation/' },
      to: { path: '^src/.*/infrastructure/|^src/downstream/' },
    },
    {
      name: 'module-code-no-infrastructure-import',
      severity: 'error',
      comment:
        'Concrete infrastructure is bound only by module composition roots.',
      from: {
        path: '^src/modules/[^/]+/(?!infrastructure/)(?!.*[.]spec[.]ts$)(?![^/]+[.]module[.]ts$)',
      },
      to: { path: '^src/modules/[^/]+/infrastructure/' },
    },
    {
      name: 'no-test-helpers-in-production-code',
      severity: 'error',
      comment:
        'In-memory adapters under a module testing/ folder are test doubles; production code must depend on ports instead.',
      from: {
        path: '^src/',
        pathNot: ['[.]spec[.]ts$', '^src/modules/[^/]+/testing/'],
      },
      to: { path: '^src/modules/[^/]+/testing/' },
    },
    {
      name: 'common-no-business-module-import',
      severity: 'error',
      comment:
        'Cross-cutting primitives do not depend on a business module. A port, vocabulary, or rule a single module owns belongs to that module, not to the cross-cutting tree (ADR-0061).',
      from: { path: '^src/common/' },
      to: { path: '^src/modules/' },
    },
    crossModuleRule(),
  ],
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: '(^|/)(dist|coverage)(/|$)',
    },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
  },
};
