import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import tsModule from 'typescript';
import cacheHelpers from './dependency-cruiser-cache.cjs';

const root = process.cwd();
const ts = /** @type {typeof import('typescript')} */ (tsModule);
const srcDirectory = join(root, 'src');
const sourceFiles = collectTypeScriptFiles(srcDirectory);
/** @type {Map<string, string>} */
const sourceTextByPath = new Map();

/** @param {string} file @returns {string} */
function sourceText(file) {
  let source = sourceTextByPath.get(file);
  if (source === undefined) {
    source = readFileSync(file, 'utf8');
    sourceTextByPath.set(file, source);
  }
  return source;
}

/** @param {string} message */
function fail(message) {
  console.error(`Architecture check failed: ${message}`);
  process.exitCode = 1;
}

/** @param {string} directory @returns {string[]} */
function collectTypeScriptFiles(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

const catalogPath = join(root, 'src', 'catalog', 'operation-catalog.ts');
const catalog = sourceText(catalogPath);
const expectedPaths = [
  '/v1/ielts/writing/task1/grade',
  '/v1/ielts/writing/task2/grade',
  '/v1/ielts/speaking/grading',
  '/v1/ielts/speaking/grading-json',
  '/v2/ielts/writing/task1/grade',
  '/v2/ielts/writing/task2/grade',
  '/v2/ielts/writing/micro-exercises',
  '/v2/ielts/writing/long-writing-exercises',
  '/v2/ielts/writing/micro-exercises/grade',
  '/v2/ielts/speaking/questions/grade',
  '/v2/ielts/speaking/parts/grade',
  '/v2/ielts/speaking/tests/grade',
  '/v2/ielts/speaking/responses/{response_id}',
  '/v2/ielts/speaking/parts/{part_result_id}',
  '/v2/ielts/speaking/tests/{test_id}',
];

for (const path of expectedPaths) {
  if (!catalog.includes(path)) {
    fail(`operation catalog is missing ${path}`);
  }
}

if ((catalog.match(/timeoutMs:\s*\d/g) ?? []).length !== expectedPaths.length) {
  fail('every initial operation must declare exactly one timeoutMs');
}

const downstreamDirectory = join(root, 'src', 'downstream');
for (const file of sourceFiles.filter((file) =>
  file.startsWith(`${downstreamDirectory}${sep}`),
)) {
  if (file.endsWith('.spec.ts')) {
    continue;
  }

  const source = sourceText(file);
  if (/https?:\/\//i.test(source)) {
    fail(
      `${relative(root, file)} contains a host literal; use trusted downstream configuration`,
    );
  }
}

// AGENTS.md: downstream adapters are pure mappers, and the dispatcher owns
// hosts, timeouts, cancellation, tokens, and error translation. The host
// literal check above is one face of that; these are the others. Each entry is
// a thing a pure mapper never needs, named by the reason a reader is given.
// Module specifiers are matched whole, so a relative `./client` never trips a
// package name.
// shortcut: this reads syntax, not types, so an alias such as `const f = fetch`
// or a renamed `console` slips through. Reach for the type checker only if an
// alias ever shows up in review.
/** @type {ReadonlyArray<{ category: string, pattern: RegExp }>} */
const DOWNSTREAM_FORBIDDEN_MODULES = [
  {
    category: 'network client',
    pattern:
      /^(?:node:)?(?:https?|http2|net|tls|dgram|dns(?:\/promises)?)$|^(?:undici|axios|got|ky|node-fetch|cross-fetch|superagent|ws|@nestjs\/axios|@nestjs\/microservices|@grpc\/.+)$/,
  },
  {
    // Files count as storage; an `infrastructure` folder of any module is where
    // a repository or client lives, and `persistence` and `secrets` build them.
    category: 'persistence or storage',
    pattern:
      /^(?:node:)?fs(?:\/promises)?$|^(?:pg|pg-.+|ioredis|redis|@redis\/.+|@prisma\/.+|@prisma-client\/.+|@aws-sdk\/.+|@smithy\/.+)$|^@\/modules\/(?:persistence|secrets)(?:\/|$)|\/infrastructure(?:\/|$)/,
  },
  {
    category: 'the environment',
    pattern: /^@nestjs\/config$|^@\/config(?:\/|$)/,
  },
  {
    category: 'logging',
    pattern: /^(?:pino|winston|bunyan|log4js|loglevel|consola|debug)$/,
  },
];

/** Names that make a file a logger when imported from the Nest core package. */
const DOWNSTREAM_NEST_LOGGERS = new Set([
  'Logger',
  'ConsoleLogger',
  'LoggerService',
]);

/** Runtimes that expose the process environment as a property named `env`. */
const DOWNSTREAM_ENVIRONMENT_HOLDERS = new Set(['process', 'Bun', 'Deno']);

/** @type {ReadonlySet<string>} */
const DOWNSTREAM_NETWORK_GLOBALS = new Set([
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
]);

/** What a downstream adapter is told when it breaks the rule, per category. */
const DOWNSTREAM_PURITY_REASON = {
  'network client':
    'the dispatcher owns hosts, timeouts, and every network client',
  'persistence or storage':
    'durable state is reached through application ports, never from a mapper',
  'the environment':
    'configuration reaches it as an argument from the dispatcher, never from the process',
  logging:
    'the dispatcher translates errors and owns telemetry, so a mapper returns or throws instead',
};

/** @param {import('typescript').Expression} expression @returns {boolean} */
function isEnvironmentHolder(expression) {
  return (
    ts.isIdentifier(expression) &&
    DOWNSTREAM_ENVIRONMENT_HOLDERS.has(expression.text)
  );
}

/** @param {import('typescript').Node} node @returns {string | undefined} */
function moduleSpecifierOf(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteral(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    const [argument] = node.arguments;
    const isLoader =
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require');
    if (
      isLoader &&
      argument !== undefined &&
      ts.isStringLiteralLike(argument)
    ) {
      return argument.text;
    }
  }
  return undefined;
}

/**
 * What in one downstream source file a pure mapper must not do.
 * @param {import('typescript').SourceFile} sourceFile
 * @returns {Array<{ line: number, category: string, detail: string }>}
 */
function downstreamImpurities(sourceFile) {
  /** @type {Array<{ line: number, category: string, detail: string }>} */
  const found = [];
  /** @param {import('typescript').Node} node @param {string} category @param {string} detail */
  function report(node, category, detail) {
    const line =
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
      1;
    found.push({ line, category, detail });
  }

  /** @param {import('typescript').Node} node */
  function visit(node) {
    const specifier = moduleSpecifierOf(node);
    if (specifier !== undefined) {
      const entry = DOWNSTREAM_FORBIDDEN_MODULES.find(({ pattern }) =>
        pattern.test(specifier),
      );
      if (entry !== undefined) {
        report(node, entry.category, `imports '${specifier}'`);
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'fetch') {
        report(node, 'network client', 'calls fetch');
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'globalThis' &&
        callee.name.text === 'fetch'
      ) {
        report(node, 'network client', 'calls globalThis.fetch');
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      DOWNSTREAM_NETWORK_GLOBALS.has(node.expression.text)
    ) {
      report(node, 'network client', `constructs ${node.expression.text}`);
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'env' &&
      isEnvironmentHolder(node.expression)
    ) {
      report(node, 'the environment', `reads ${node.expression.getText()}.env`);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'env' &&
      isEnvironmentHolder(node.expression)
    ) {
      report(
        node,
        'the environment',
        `reads ${node.expression.getText()}['env']`,
      );
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'env' &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      report(node, 'the environment', 'reads import.meta.env');
    }
    if (
      ts.isImportDeclaration(node) &&
      moduleSpecifierOf(node) === '@nestjs/common' &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (DOWNSTREAM_NEST_LOGGERS.has(imported)) {
          report(
            element,
            'logging',
            `imports ${imported} from '@nestjs/common'`,
          );
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'console' ||
        (node.expression.text === 'process' &&
          (node.name.text === 'stdout' || node.name.text === 'stderr')))
    ) {
      report(
        node,
        'logging',
        `writes through ${node.expression.text}.${node.name.text}`,
      );
    }
    // `const { env } = process` takes the environment without naming `.env`.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      isEnvironmentHolder(node.initializer) &&
      node.name.elements.some(
        (element) => (element.propertyName ?? element.name).getText() === 'env',
      )
    ) {
      report(node, 'the environment', 'destructures env from the process');
    }

    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

for (const file of sourceFiles.filter((file) =>
  file.startsWith(`${downstreamDirectory}${sep}`),
)) {
  if (file.endsWith('.spec.ts')) {
    continue;
  }

  const sourceFile = ts.createSourceFile(
    file,
    sourceText(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const { line, category, detail } of downstreamImpurities(sourceFile)) {
    fail(
      `${relative(root, file)}:${line} ${detail} (${category}); a downstream adapter is a pure mapper, so ${DOWNSTREAM_PURITY_REASON[category]}`,
    );
  }
}

const configurationDirectory = join(srcDirectory, 'config');
const cliDirectory = join(srcDirectory, 'cli');
const postgresPoolFactoryPath = join(
  srcDirectory,
  'common',
  'postgres',
  'postgres-pool.ts',
);
for (const file of sourceFiles) {
  if (
    file.endsWith('.spec.ts') ||
    file.startsWith(configurationDirectory) ||
    file.startsWith(cliDirectory)
  ) {
    continue;
  }

  const source = sourceText(file);
  if (/\bprocess\.env\b/.test(source)) {
    fail(
      `${relative(root, file)} reads process.env outside the configuration boundary; inject validated configuration instead`,
    );
  }
}

for (const file of sourceFiles) {
  if (file.endsWith('.spec.ts') || file === postgresPoolFactoryPath) {
    continue;
  }

  const source = sourceText(file);
  const importsPgPool =
    /\bimport\s*\{[^}]*\bPool\b(?:\s+as\s+\w+)?[^}]*\}\s*from\s*['"]pg['"]/.test(
      source,
    ) || /\bimport\s+(?:\*\s+as\s+\w+|\w+)\s+from\s*['"]pg['"]/.test(source);
  if (importsPgPool && /\bnew\s+(?:\w+\.)?\w*Pool\s*\(/.test(source)) {
    fail(
      `${relative(root, file)} constructs a PostgreSQL pool directly; use createPostgresPool so every pool observes connection errors`,
    );
  }
}

// Prisma types never reach application or domain code: infrastructure maps
// rows to the port types those layers already speak, and a repository is the
// only place a Prisma model belongs. Matching the specifier here rather than
// in dependency-cruiser is deliberate - the generated client is written outside
// `src/`, so dependency-cruiser never reads it as a module edge.
//
// `src/modules/persistence` is not exempt as a module: its `infrastructure`
// folder builds the shared clients and may import the generated client, and
// its `public` facade re-exports from there without naming the client itself.
// Static imports, re-exports, dynamic `import()`, and `require()` all count,
// and so does a spec outside infrastructure.
const PRISMA_CLIENT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]@prisma-client\//;

// A `testing/` folder holds test doubles, which production code cannot import
// (`no-test-helpers-in-production-code`), so naming the client's type there
// does not carry Prisma into a layer.
for (const file of sourceFiles) {
  const segments = file.split(sep);
  if (segments.includes('infrastructure') || segments.includes('testing')) {
    continue;
  }

  if (PRISMA_CLIENT_SPECIFIER.test(sourceText(file))) {
    fail(
      `${relative(root, file)} imports the generated Prisma client; only infrastructure may, because Prisma types stay inside the persistence layer (ADR-0088)`,
    );
  }
}

const secretsInfrastructureDirectory = join(
  srcDirectory,
  'modules',
  'secrets',
  'infrastructure',
);
const secretsModulePath = join(
  srcDirectory,
  'modules',
  'secrets',
  'secrets.module.ts',
);
for (const file of sourceFiles) {
  if (
    file.endsWith('.spec.ts') ||
    file.startsWith(secretsInfrastructureDirectory) ||
    file.startsWith(configurationDirectory) ||
    file.startsWith(cliDirectory) ||
    file === secretsModulePath
  ) {
    continue;
  }

  const source = sourceText(file);
  if (/\bvault\b|AIHUB_RUNTIME_SECRETS_FILE/i.test(source)) {
    fail(
      `${relative(root, file)} contains Vault-specific infrastructure; keep it behind the runtime-secret provider`,
    );
  }
}

// Every request body reaches its operation's TypeBox contract through
// `parseRequestBody`, so a `default` in a schema means the same thing on every
// route. A controller that calls TypeBox itself skips that helper: `Value.Check`
// alone drops the defaults, and `Value.Parse` alone converts before it asserts,
// so a body of the wrong type would decode instead of being rejected.
//
// A call that is not body validation - a query, one nested field that answers
// its own error code, a response envelope - stays, but only when it says why.
// The marker is per call rather than per file on purpose: a file allowed one
// such call would otherwise also be allowed to start validating a body beside
// it, which is the gap this rule exists to close. The next line counts because
// the formatter moves a trailing comment down onto its own line.
const BODY_VALIDATION_MARKER = 'arch-check:';

for (const file of sourceFiles) {
  if (file.endsWith('.spec.ts') || !file.includes(`${sep}presentation${sep}`)) {
    continue;
  }

  const lines = sourceText(file).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!/\bValue\.(?:Check|Parse)\s*\(/.test(line)) {
      continue;
    }

    const markedOn = `${line}\n${lines[index + 1] ?? ''}`;
    if (markedOn.includes(BODY_VALIDATION_MARKER)) {
      continue;
    }

    fail(
      `${relative(root, file)}:${index + 1} calls TypeBox directly; route a request body through parseRequestBody, or, if this call is not body validation, mark it with "${BODY_VALIDATION_MARKER} <reason>"`,
    );
  }
}

// `isRecord` means one thing: the guard in `src/common/is-record.ts`. A local
// declaration brings back the second meaning (one that accepts arrays) the
// register's M10 row removed. Domain code may not import `src/common`, so a
// domain copy, or any other that must stay, says why on its own line or the
// line above, with the same marker the other rules use.
const IS_RECORD_DECLARATION =
  /\b(?:function\s+isRecord\b|(?:const|let)\s+isRecord\s*[=:])/;
const IS_RECORD_OWNER = join(srcDirectory, 'common', 'is-record.ts');

for (const file of sourceFiles) {
  if (file.endsWith('.spec.ts') || file === IS_RECORD_OWNER) {
    continue;
  }

  const lines = sourceText(file).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!IS_RECORD_DECLARATION.test(line)) {
      continue;
    }

    const markedOn = `${lines[index - 1] ?? ''}\n${line}`;
    if (markedOn.includes(BODY_VALIDATION_MARKER)) {
      continue;
    }

    fail(
      `${relative(root, file)}:${index + 1} declares its own isRecord; import it from '@/common/is-record', or mark the declaration with "${BODY_VALIDATION_MARKER} <reason>"`,
    );
  }
}

// The request-id pattern is stated once, in `src/contracts/response-meta.ts`
// (#1422). A contract that spells the pattern out again brings back the copy
// that can drift from the id `generateRequestId` mints, so it imports
// `RequestIdSchema` or `ResponseMetaSchema` instead.
const REQUEST_ID_PATTERN_LITERAL = 'req_[0-9A-HJKMNP-TV-Z]{26}';
const REQUEST_ID_PATTERN_OWNER = join(
  srcDirectory,
  'contracts',
  'response-meta.ts',
);

const contractsDirectory = join(srcDirectory, 'contracts');
for (const file of sourceFiles.filter((file) =>
  file.startsWith(`${contractsDirectory}${sep}`),
)) {
  if (file.endsWith('.spec.ts') || file === REQUEST_ID_PATTERN_OWNER) {
    continue;
  }

  const lines = sourceText(file).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.includes(REQUEST_ID_PATTERN_LITERAL)) {
      continue;
    }

    const markedOn = `${lines[index - 1] ?? ''}\n${line}`;
    if (markedOn.includes(BODY_VALIDATION_MARKER)) {
      continue;
    }

    fail(
      `${relative(root, file)}:${index + 1} restates the request-id pattern; import RequestIdSchema or ResponseMetaSchema from '@/contracts/response-meta', or mark the line with "${BODY_VALIDATION_MARKER} <reason>"`,
    );
  }
}

const QUERY_VALIDATION_MARKER = 'arch-check:';

/** @param {import('typescript').SourceFile} sourceFile @param {import('typescript').Node} node @param {string[]} lines */
function hasQueryValidationMarker(sourceFile, node, lines) {
  const line = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  ).line;
  return `${lines[line] ?? ''}\n${lines[line + 1] ?? ''}`.includes(
    QUERY_VALIDATION_MARKER,
  );
}

const RAW_SQL_METHODS = new Set(['$queryRawUnsafe', '$executeRawUnsafe']);
const RAW_SQL_MARKER = /(?:^|\s)(?:\/\/|\/\*|\*)\s*arch-check:\s*\S/;

/** @param {import('typescript').CallExpression} call */
function rawSqlMethodName(call) {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return RAW_SQL_METHODS.has(callee.name.text) ? callee.name.text : undefined;
  }
  if (
    ts.isElementAccessExpression(callee) &&
    callee.argumentExpression !== undefined &&
    ts.isStringLiteralLike(callee.argumentExpression)
  ) {
    return RAW_SQL_METHODS.has(callee.argumentExpression.text)
      ? callee.argumentExpression.text
      : undefined;
  }
  return undefined;
}

/** @param {import('typescript').Node} node */
function sqlLexicalScope(node) {
  let current = node;
  while (
    current.parent !== undefined &&
    !ts.isSourceFile(current) &&
    !ts.isBlock(current) &&
    !isFunctionLikeNode(current)
  ) {
    current = current.parent;
  }
  return current;
}

/** @param {import('typescript').SourceFile} sourceFile */
function sqlConstDeclarations(sourceFile) {
  /** @type {Map<import('typescript').Node, Map<string, import('typescript').VariableDeclaration[]>>} */
  const declarationsByScope = new Map();

  /** @param {import('typescript').Node} node */
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const scope = sqlLexicalScope(node);
      let declarations = declarationsByScope.get(scope);
      if (declarations === undefined) {
        declarations = new Map();
        declarationsByScope.set(scope, declarations);
      }
      const matches = declarations.get(node.name.text) ?? [];
      matches.push(node);
      declarations.set(node.name.text, matches);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return declarationsByScope;
}

/** @param {import('typescript').Node} node @param {string} name @param {Map<import('typescript').Node, Map<string, import('typescript').VariableDeclaration[]>>} declarationsByScope */
function sqlConstDeclaration(node, name, declarationsByScope) {
  let scope = sqlLexicalScope(node);
  while (scope !== undefined) {
    const declarations = declarationsByScope.get(scope)?.get(name);
    if (declarations !== undefined) {
      return declarations.length === 1 ? declarations[0] : undefined;
    }
    scope =
      scope.parent === undefined ? undefined : sqlLexicalScope(scope.parent);
  }
  return undefined;
}

/** @param {import('typescript').Expression} expression @param {Map<import('typescript').Node, Map<string, import('typescript').VariableDeclaration[]>>} declarationsByScope @param {Set<import('typescript').VariableDeclaration>} seen */
function isStaticSqlExpression(
  expression,
  declarationsByScope,
  seen = new Set(),
) {
  let value = expression;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isSatisfiesExpression(value)
  ) {
    value = value.expression;
  }

  if (ts.isStringLiteralLike(value)) {
    return true;
  }
  if (!ts.isIdentifier(value)) {
    return false;
  }

  const declaration = sqlConstDeclaration(
    value,
    value.text,
    declarationsByScope,
  );
  if (
    declaration === undefined ||
    declaration.initializer === undefined ||
    seen.has(declaration)
  ) {
    return false;
  }
  seen.add(declaration);
  return isStaticSqlExpression(
    declaration.initializer,
    declarationsByScope,
    seen,
  );
}

/** @param {import('typescript').SourceFile} sourceFile @param {import('typescript').Node} node @param {string[]} lines */
function hasRawSqlMarker(sourceFile, node, lines) {
  const line = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  ).line;
  return [lines[line - 1], lines[line], lines[line + 1]].some(
    (candidate) => candidate !== undefined && RAW_SQL_MARKER.test(candidate),
  );
}

for (const file of sourceFiles) {
  if (file.endsWith('.spec.ts')) continue;

  const source = sourceText(file);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const lines = source.split(/\r?\n/);
  const declarationsByScope = sqlConstDeclarations(sourceFile);

  /** @param {import('typescript').Node} node */
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const method = rawSqlMethodName(node);
      const query = node.arguments[0];
      if (
        method !== undefined &&
        query !== undefined &&
        !isStaticSqlExpression(query, declarationsByScope) &&
        !hasRawSqlMarker(sourceFile, node, lines)
      ) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            .line + 1;
        fail(
          `${relative(root, file)}:${line} passes dynamic SQL to ${method}; use a static SQL literal with bound values, or mark the call with "arch-check: <reason>"`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

/** @param {import('typescript').Node} node @returns {node is import('typescript').CallExpression} */
function isParseRequestQueryCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'parseRequestQuery'
  );
}

/** @param {import('typescript').Node} node */
function isDirectlyPassedToQueryHelper(node) {
  let argument = node;
  while (ts.isParenthesizedExpression(argument.parent)) {
    argument = argument.parent;
  }

  const call = argument.parent;
  return isParseRequestQueryCall(call) && call.arguments[1] === argument;
}

/** @param {import('typescript').ParameterDeclaration} parameter */
function queryDecorator(parameter) {
  const decorators = ts.canHaveDecorators(parameter)
    ? (ts.getDecorators(parameter) ?? [])
    : [];

  for (const decorator of decorators) {
    const expression = decorator.expression;
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'Query'
    ) {
      return {
        decorator,
        isWholeQuery: expression.arguments.length === 0,
      };
    }
    if (ts.isIdentifier(expression) && expression.text === 'Query') {
      return { decorator, isWholeQuery: false };
    }
  }

  return undefined;
}

/** @param {import('typescript').Node} node @returns {node is import('typescript').FunctionLikeDeclaration} */
function isFunctionLikeNode(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** @param {import('typescript').ParameterDeclaration} parameter */
function queryParameterIsValidated(parameter) {
  if (!ts.isIdentifier(parameter.name)) {
    return false;
  }

  let owner = parameter.parent;
  while (owner !== undefined && !isFunctionLikeNode(owner)) {
    owner = owner.parent;
  }
  if (owner?.body === undefined) {
    return false;
  }

  let isValidated = false;
  /** @param {import('typescript').Node} node */
  function visit(node) {
    if (node !== owner.body && isFunctionLikeNode(node)) {
      return;
    }
    if (
      isParseRequestQueryCall(node) &&
      node.arguments[1] !== undefined &&
      ts.isIdentifier(node.arguments[1]) &&
      node.arguments[1].text === parameter.name.text
    ) {
      isValidated = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(owner.body);
  return isValidated;
}

for (const file of sourceFiles) {
  if (file.endsWith('.spec.ts') || !file.endsWith('.controller.ts')) {
    continue;
  }

  const source = sourceText(file);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const lines = source.split(/\r?\n/);

  /** @param {import('typescript').Node} node */
  function visit(node) {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'query' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'request' &&
      !isDirectlyPassedToQueryHelper(node) &&
      !hasQueryValidationMarker(sourceFile, node, lines)
    ) {
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1;
      fail(
        `${relative(root, file)}:${line} reads request.query outside parseRequestQuery; pass it as the raw argument or mark it with "${QUERY_VALIDATION_MARKER} <reason>"`,
      );
    }

    if (node.kind === ts.SyntaxKind.Parameter) {
      const query = queryDecorator(node);
      const isValidated =
        query?.isWholeQuery === true && queryParameterIsValidated(node);
      if (
        query !== undefined &&
        !isValidated &&
        !hasQueryValidationMarker(sourceFile, query.decorator, lines)
      ) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(
            query.decorator.getStart(sourceFile),
          ).line + 1;
        fail(
          `${relative(root, file)}:${line} uses @Query without validating the whole query through parseRequestQuery; use @Query() with the helper or mark it with "${QUERY_VALIDATION_MARKER} <reason>"`,
        );
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

// ADR-0054 / #784: every statement that stores a session takes a
// SessionAdmission, and the second-factor check mints it. The one other way to
// get one, `admitSessionContinuation`, skips that check because it continues a
// session that already exists, so only the Refresh Token rotation may name it.
// The type system cannot see who calls an exported function, so check the
// source text.
const SESSION_CONTINUATION_USERS = new Set([
  'src/modules/auth/mfa/infrastructure/auth-mfa-session.guard.ts',
  'src/modules/auth/web-sessions/infrastructure/postgres-refresh-session.repository.ts',
]);
for (const file of sourceFiles) {
  if (file.endsWith('.spec.ts')) continue;
  const relativePath = relative(root, file).replace(/\\/g, '/');
  if (SESSION_CONTINUATION_USERS.has(relativePath)) continue;
  if (/\badmitSessionContinuation\b/.test(sourceText(file))) {
    fail(
      `${relativePath} names admitSessionContinuation, which stores a session without the second-factor check; only the Refresh Token rotation may continue a session this way (ADR-0054)`,
    );
  }
}

// ADR-0139: the package manager is Bun, and a child process that runs pnpm
// against a Bun-installed `node_modules` breaks concurrent readers of it. Run
// Node, `tsx` or dependency-cruiser through `process.execPath`, or a package
// script through `bun run`.
const retiredPackageManagerCall = /['"`]pnpm(?:\.cmd)?['"`]/;
const issue225BenchmarkPath = 'scripts/ops/dev-restart-benchmark/benchmark.mjs';
const issue225BenchmarkReason =
  'arch-check: #225 requires the real pnpm dev command';
for (const directory of ['scripts', 'src', 'test']) {
  const files = readdirSync(join(root, directory), {
    recursive: true,
    withFileTypes: true,
  }).filter((entry) => entry.isFile() && /\.(?:[cm]?js|ts)$/.test(entry.name));
  for (const entry of files) {
    const file = join(entry.parentPath, entry.name);
    // This file holds the pattern above, which is itself such a literal.
    if (entry.name === 'check-architecture.mjs') continue;
    const source = readFileSync(file, 'utf8');
    const relativePath = relative(root, file).replace(/\\/g, '/');
    const issue225Benchmark =
      relativePath === issue225BenchmarkPath &&
      source.includes(issue225BenchmarkReason);
    if (retiredPackageManagerCall.test(source) && !issue225Benchmark) {
      fail(
        `${relativePath} spawns pnpm; use process.execPath or 'bun run' (ADR-0139)`,
      );
    }
  }
}

if (process.exitCode !== undefined) {
  process.exit(process.exitCode);
}

// ADR-0066 / #674: an inner layer must not augment the web framework's
// request type. dependency-cruiser cannot see `declare module`, so check the
// source text directly.
for (const layer of ['application', 'domain']) {
  for (const file of sourceFiles) {
    if (file.endsWith('.spec.ts')) continue;
    const relativePath = relative(root, file).replace(/\\/g, '/');
    if (!relativePath.includes(`/${layer}/`)) continue;
    const source = sourceText(file);
    if (/declare\s+module\s+['"]fastify['"]/.test(source)) {
      fail(
        `${relativePath} declares module 'fastify' from the ${layer} layer; move the augmentation to presentation/`,
      );
    }
  }
}

// ADR-0090 / #673: no `as unknown as <application-declared type>` cast in
// infrastructure. Application ports stay free of Prisma-shaped concepts; a
// transaction or client crosses the seam through a thin infrastructure adapter
// instead of a compiler-forcing cast. Justified exceptions carry a comment and
// are listed in CAST_ALLOWLIST below.
const CAST_ALLOWLIST = new Set([]);

const applicationTypeNames = new Set();
for (const file of sourceFiles) {
  const relativePath = relative(root, file).replace(/\\/g, '/');
  if (!relativePath.includes('/application/')) continue;
  const source = sourceText(file);
  for (const match of source.matchAll(/export\s+(?:type|interface)\s+(\w+)/g)) {
    applicationTypeNames.add(match[1]);
  }
}

for (const file of sourceFiles) {
  const relativePath = relative(root, file).replace(/\\/g, '/');
  if (!relativePath.includes('/infrastructure/')) continue;
  if (file.endsWith('.spec.ts')) continue;
  const source = sourceText(file);
  for (const match of source.matchAll(/as\s+unknown\s+as\s+(\w+)/g)) {
    const typeName = match[1];
    if (!applicationTypeNames.has(typeName)) continue;
    if (CAST_ALLOWLIST.has(`${relativePath}::${typeName}`)) continue;
    fail(
      `${relativePath}: \`as unknown as ${typeName}\` casts an application-declared type in infrastructure; introduce a thin adapter instead.`,
    );
  }
}

const dependencyCruiserConfigPath = join(root, '.dependency-cruiser.cjs');
// shortcut: leaves one ignored cache folder per policy/resolver revision; prune if these inputs change often.
const dependencyCruiserCachePath = cacheHelpers.dependencyCruiserCacheDirectory(
  root,
  [
    readFileSync(dependencyCruiserConfigPath, 'utf8'),
    readFileSync(join(root, 'tsconfig.json'), 'utf8'),
    readFileSync(join(root, 'package.json'), 'utf8'),
    readFileSync(join(root, 'bun.lock'), 'utf8'),
  ],
);
const result = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'),
    '--cache',
    dependencyCruiserCachePath,
    '--cache-strategy',
    'content',
    '--config',
    '.dependency-cruiser.cjs',
    '--output-type',
    'err-long',
    'src',
  ],
  { cwd: root, stdio: 'inherit' },
);

if (result.error) {
  console.error(`Could not start dependency-cruiser: ${result.error.message}`);
  process.exit(1);
}

process.exit(Math.max(process.exitCode ?? 0, result.status ?? 1));
