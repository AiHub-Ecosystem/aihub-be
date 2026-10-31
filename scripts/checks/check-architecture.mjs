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

if (process.exitCode !== undefined) {
  process.exit(process.exitCode);
}

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
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
    readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'),
  ],
);
// `--cache` is an absolute path and may contain spaces on Windows.
const windows = process.platform === 'win32';
const quote = (/** @type {string} */ arg) =>
  /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;

const result = spawnSync(
  command,
  [
    'exec',
    'depcruise',
    '--cache',
    dependencyCruiserCachePath,
    '--cache-strategy',
    'content',
    '--config',
    '.dependency-cruiser.cjs',
    '--output-type',
    'err-long',
    'src',
  ].map((arg) => (windows ? quote(arg) : arg)),
  { cwd: root, shell: windows, stdio: 'inherit' },
);

if (result.error) {
  console.error(`Could not start dependency-cruiser: ${result.error.message}`);
  process.exit(1);
}

process.exit(Math.max(process.exitCode ?? 0, result.status ?? 1));
