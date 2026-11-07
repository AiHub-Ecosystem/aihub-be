const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const modulesDirectory = path.join(__dirname, 'src', 'modules');

/** @typedef {{relative: string, parentPath: string, source: string}} ModuleFile */
/** @type {ReturnType<typeof discoverModuleSeams> | undefined} */
let moduleDiscovery;

/**
 * One config load defines several rules from the same source tree; cache the
 * single discovery pass so each source file is read once for all of them.
 */

/** @param {string} file @returns {string} */
function seamPattern(file) {
  return `^${path
    .relative(process.cwd(), file)
    .split(/[\\/]/)
    .join('/')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/** @returns {{seams: {decorators: string[], publicApis: string[], exports: string[], sharedPrimitives: string[]}}} */
function discoverModuleSeams() {
  if (moduleDiscovery) return moduleDiscovery;

  const entries = readdirSync(modulesDirectory, {
    recursive: true,
    withFileTypes: true,
  });
  /** @type {ModuleFile[]} */
  const files = [];
  /** @type {Map<string, string>} */
  const sourcesByPath = new Map();
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.spec.ts')
    ) {
      continue;
    }
    const file = path.join(entry.parentPath, entry.name);
    const source = readFileSync(file, 'utf8');
    sourcesByPath.set(file, source);
    files.push({
      parentPath: entry.parentPath,
      relative: seamPattern(file),
      source,
    });
  }

  const decorators = files
    .filter(({ source }) =>
      /export function \w+\([^)]*\):\s*(Class|Method)Decorator\b/.test(source),
    )
    .map(({ relative }) => relative);
  const publicApis = files
    .filter(({ parentPath }) => parentPath.split(/[\\/]/).includes('public'))
    .map(({ relative }) => relative);
  const sharedPrimitives = files
    .filter(
      ({ parentPath, source }) =>
        parentPath.split(/[\\/]/).includes('presentation') &&
        /declare module ['"]fastify['"]/.test(source),
    )
    .map(({ relative }) => relative);

  /** @type {Map<string, Set<string>>} */
  const exported = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.parentPath !== modulesDirectory) continue;
    const name = entry.name;
    const source = sourcesByPath.get(
      path.join(modulesDirectory, name, `${name}.module.ts`),
    );
    if (!source) continue;
    const at = source.indexOf('exports:');
    const open = at < 0 ? -1 : source.indexOf('[', at);
    if (open < 0) continue;
    let depth = 0;
    let end = open;
    for (let index = open; index < source.length; index++) {
      if (source[index] === '[') depth++;
      else if (source[index] === ']') {
        depth--;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    exported.set(
      name,
      new Set(
        source
          .slice(open + 1, end)
          .split(',')
          .map(
            (part) =>
              part
                .trim()
                .replace(/\/\/.*$/gm, '')
                .trim()
                .match(/^(?:type\s+)?([A-Za-z_$][\w$]*)/)?.[1],
          )
          .filter((symbol) => typeof symbol === 'string'),
      ),
    );
  }

  const exportsByFile = [];
  for (const [module, symbols] of exported) {
    for (const item of files) {
      if (!item.parentPath.startsWith(path.join(modulesDirectory, module))) {
        continue;
      }
      const declaresExported = [...symbols].some((symbol) =>
        new RegExp(
          `^(?:export\\s+(?:abstract\\s+)?(?:class|const|function|interface|type|enum)\\s+${symbol}\\b|export\\s*\\{[^}]*\\b${symbol}\\b)`,
          'm',
        ).test(item.source),
      );
      if (declaresExported) exportsByFile.push(item.relative);
    }
  }

  moduleDiscovery = {
    seams: {
      decorators,
      publicApis,
      exports: exportsByFile,
      sharedPrimitives,
    },
  };
  return moduleDiscovery;
}

/**
 * A business module reaches another through its public seam and nothing else.
 * The seam is three things (ADR-0066):
 *
 *   1. `<module>.module.ts`, which is Nest composition wiring.
 *   2. `application/**\/*.port.ts`, an application port the owner declares.
 *   3. A presentation primitive that declares `module 'fastify'`, because it
 *      extends the shared request type every module already agrees on.
 *   4. A file whose module exports a symbol it declares, which is how NestJS
 *      publishes a guard or interceptor to the modules that compose it.
 *   5. An explicit `public/` facade, which declares the module's plain
 *      TypeScript API for values that are not Nest providers.
 *   6. A file that declares a Nest decorator, which composes at import time
 *      and so can never travel through the DI container.
 *
 * `from.path` captures the module name as group 1 and `to.path` refers back to
 * it as `$1` inside a negative lookahead, so one rule expresses "any module to
 * a different module" without generating a rule per module pair. The seam
 * patterns in `to.pathNot` exempt the module file, application ports,
 * explicit `public/` facades, and shared primitives of whichever module the
 * target turns out to be.
 *
 * This rule is an error. Nest exports are matched by file, so the exemption
 * covers a file declaring an exported symbol, not only that symbol. Plain
 * TypeScript APIs are published through explicit `public/` facades instead.
 */
function crossModuleRule() {
  return {
    name: 'no-cross-module-internal-import',
    severity: 'error',
    comment:
      "A business module imports another module's internal path. Use the module file, an application port, an explicit public/ facade, a Nest export, decorator, or shared request primitive (ADR-0066).",
    from: {
      // Group 1 is the importing module's name.
      path: '^src/modules/([^/]+)/',
      pathNot: '[.]spec[.]ts$',
    },
    to: {
      path: '^src/modules/(?!$1/)[^/]+/',
      pathNot: [...seamPathNots('[^/]+'), ...sharedPrimitivePaths()],
    },
  };
}

/**
 * `src/cli` is the composition root for the Operator surface: it is where a
 * command decides which Postgres client and which repository to construct,
 * exactly as `*.module.ts` does for the HTTP surface. Binding infrastructure is
 * that job, so `module-code-no-infrastructure-import` deliberately does not
 * reach this tree and this rule does not report it either.
 *
 * What it does report is a command reaching past the seam into a module's
 * application logic or domain. That logic belongs behind a port or in an
 * explicit public/ facade the module publishes.
 */
function cliRule() {
  return {
    name: 'no-cli-module-internal-import',
    severity: 'error',
    comment:
      "An Operator command imports a module's internal path. Use an application port or explicit public/ facade; constructing infrastructure remains the CLI composition root's job (ADR-0066).",
    from: {
      path: '^src/cli/',
      pathNot: '[.]spec[.]ts$',
    },
    to: {
      path: '^src/modules/[^/]+/',
      pathNot: [
        '^src/modules/[^/]+/(infrastructure/|.*/infrastructure/)',
        ...seamPathNots('[^/]+'),
        ...sharedPrimitivePaths(),
      ],
    },
  };
}

/**
 * `GradedRequest` and `RequireOperation` are consumed by three modules each
 * and neither can be published through a Nest `exports:` array, because a
 * decorator runs when it is applied and is never resolved by the container.
 * Reading it as its own kind of seam keeps a deliberate composition from
 * looking like a coupling bug, without adding either symbol to `exports:`
 * where it does not belong.
 */
/** @returns {string[]} */
function nestDecoratorPaths() {
  return discoverModuleSeams().seams.decorators;
}

/**
 * Plain TypeScript contracts and functions that consumers need are published
 * through files in `public/`. Unlike a maintained allowlist, the directory is
 * the module's explicit API surface and callers must import that facade.
 */
/** @returns {string[]} */
function publicModuleApiPaths() {
  return discoverModuleSeams().seams.publicApis;
}

/**
 * Nest publishes a symbol through its module's `exports:` array, and that array
 * is the seam the graded-request chain is composed from (ADR-0057). Reading it
 * from source keeps the exemption derived from the declaration rather than a
 * list, so exporting a guard is all it takes to make it reachable.
 */
/** @returns {string[]} */
function nestExportPaths() {
  return discoverModuleSeams().seams.exports;
}

/**
 * A presentation primitive that declares `module 'fastify'` extends the shared
 * request type, so it is part of the seam rather than the owning module's
 * internals. The paths are read from source instead of listed here, so a file
 * that does not declare it stays private and a new file needs no edit to this
 * config to become shared.
 */
/** @returns {string[]} */
function sharedPrimitivePaths() {
  return discoverModuleSeams().seams.sharedPrimitives;
}

/**
 * The seam `pathNot` entries every cross-module rule shares: the target's
 * module file, its application `*.port.ts` contracts, its `public/` facades,
 * the files its module publishes through Nest `exports:`, and its Nest
 * decorators. `toModule` is the target's path prefix - a literal module name
 * for the #1733 edges, `[^/]+` for the general rules that cover every pair.
 *
 * @param {string} toModule
 * @returns {string[]}
 */
function seamPathNots(toModule) {
  return [
    `^src/modules/${toModule}/[^/]+[.]module[.]ts$`,
    `^src/modules/${toModule}/(application/|.*/application/).*[.]port[.]ts$`,
    ...nestExportPaths(),
    ...publicModuleApiPaths(),
    ...nestDecoratorPaths(),
  ];
}

/**
 * #1733: an edge that carries enough cross-module traffic gets its own rule
 * pinned to the same seam set, so it cannot grow silently through the general
 * rule's wider exemptions. The general rule's shared fastify-primitive seam is
 * deliberately not offered on these edges.
 *
 * @param {{ name: string, fromPattern: string, toModule: string, comment: string }} options
 * @returns {{ name: string, severity: string, comment: string, from: { path: string, pathNot: string }, to: { path: string, pathNot: string[] } }}
 */
function restrictedEdgeRule({ name, fromPattern, toModule, comment }) {
  return {
    name,
    severity: 'error',
    comment,
    from: { path: fromPattern, pathNot: '[.]spec[.]ts$' },
    to: {
      path: `^src/modules/${toModule}/`,
      pathNot: seamPathNots(toModule),
    },
  };
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
      to: {
        path: [
          'node_modules',
          '^node:',
          '^src/downstream/',
          '^src/common/',
          '^src/config/',
        ],
      },
    },
    {
      // dependency-cruiser reports a Node built-in as `url` or `fs`, never as
      // `node:url`, so `^node:` in the rule above matches nothing. The type is
      // what identifies a built-in; the domain layer imports none.
      name: 'domain-no-runtime-modules',
      severity: 'error',
      comment:
        'Domain code imports no Node built-in: a pure function or a small decoder written in the domain replaces it.',
      from: { path: '^src/.*/domain/' },
      to: { dependencyTypes: ['core'] },
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
      name: 'application-no-nestjs',
      severity: 'error',
      comment:
        'Application code is plain TypeScript built by a module composition root. A use case carries its ports as constructor parameters, so @nestjs/* here means the wiring is hidden in decorators instead of readable in the module.',
      from: { path: '^src/.*/application/' },
      to: { path: 'node_modules/@nestjs' },
    },
    {
      name: 'presentation-no-infrastructure',
      severity: 'error',
      comment:
        'Controllers and presentation code call application ports, not adapters.',
      from: {
        path: '^src/.*[.]controller[.]ts$|^src/.*/presentation/',
        pathNot: '[.]spec[.]ts$',
      },
      to: { path: '^src/.*/infrastructure/|^src/downstream/' },
    },
    {
      name: 'infrastructure-no-presentation',
      severity: 'error',
      comment:
        'Infrastructure implements application ports and points inward, not at presentation code.',
      from: { path: '^src/.*/infrastructure/', pathNot: '[.]spec[.]ts$' },
      to: { path: '^src/.*/presentation/' },
    },
    {
      name: 'module-code-no-infrastructure-import',
      severity: 'error',
      comment:
        'Concrete infrastructure is bound only by module composition roots.',
      from: {
        path: '^src/modules/[^/]+/',
        pathNot: [
          '^src/modules/[^/]+/(infrastructure/|.*/infrastructure/)',
          '[.]spec[.]ts$',
          '[.]module[.]ts$',
        ],
      },
      to: { path: '^src/modules/[^/]+/(infrastructure/|.*/infrastructure/)' },
    },
    {
      name: 'no-business-module-owns-public-envelope',
      severity: 'error',
      comment:
        'Public response shapes live in src/common; a business module must not define the success or error envelope itself.',
      from: {
        // Definition files must live at src/common/**; the interceptor and
        // filter names do not match this exact-name pattern on purpose.
        path: '^src/modules/.*/(success-envelope|error-envelope)\\.ts$',
      },
      to: { path: '^src/' },
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
    {
      name: 'no-auth-cross-feature-internal-import',
      severity: 'error',
      comment:
        'Auth features import another feature through its public/ facade or application port; cross-cutting implementations belong under auth/shared/.',
      from: {
        path: '^src/modules/auth/([^/]+)/',
        pathNot: ['[.]spec[.]ts$', '^src/modules/auth/(public|testing)/'],
      },
      to: {
        path: '^src/modules/auth/(?!$1/)[^/]+/',
        pathNot: [
          '^src/modules/auth/public/',
          '^src/modules/auth/shared/',
          '^src/modules/auth/[^/]+/public/',
          '^src/modules/auth/[^/]+/(application/|.*/application/).*[.]port[.]ts$',
          ...nestExportPaths(),
        ],
      },
    },
    restrictedEdgeRule({
      name: 'no-identity-auth-internal-import',
      fromPattern: '^src/modules/identity/',
      toModule: 'auth',
      comment:
        "Identity reaches Auth only through Auth's published seam, narrowed for this high-volume edge (#1733): the module file, application ports, public/ facades, Nest exports, and Nest decorators.",
    }),
    restrictedEdgeRule({
      name: 'no-business-to-gateway-internal-import',
      fromPattern: '^src/modules/(writing|speaking)/',
      toModule: 'gateway',
      comment:
        "Writing and Speaking reach Gateway only through Gateway's published seam, narrowed for this high-volume edge (#1733): the module files, application ports, public/ facades, Nest exports, and Nest decorators.",
    }),
    {
      name: 'no-avatar-gateway-import',
      severity: 'error',
      comment:
        'Avatar holds no gateway import and this rule keeps it that way (#1733): every edge into Gateway, seam or not, is a violation.',
      from: { path: '^src/modules/avatar/', pathNot: '[.]spec[.]ts$' },
      to: { path: '^src/modules/gateway/' },
    },
    crossModuleRule(),
    cliRule(),
  ],
  options: {
    tsPreCompilationDeps: true,
    // Required for the `@/*` alias: dependency-cruiser reads tsconfig `paths`
    // only when a config file is named, and has no default. Without it every
    // aliased import is `not-to-unresolvable`, which is an error (ADR-0067).
    tsConfig: {
      fileName: 'tsconfig.json',
    },
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
