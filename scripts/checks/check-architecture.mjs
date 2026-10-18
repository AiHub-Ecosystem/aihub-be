import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

const root = process.cwd();

function fail(message) {
  console.error(`Architecture check failed: ${message}`);
  process.exitCode = 1;
}

function collectTypeScriptFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(path));
    } else if (entry.isFile() && path.endsWith('.ts')) {
      files.push(path);
    }
  }

  return files;
}

const catalogPath = join(root, 'src', 'catalog', 'operation-catalog.ts');
const catalog = readFileSync(catalogPath, 'utf8');
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
for (const file of collectTypeScriptFiles(downstreamDirectory)) {
  if (file.endsWith('.spec.ts')) {
    continue;
  }

  const source = readFileSync(file, 'utf8');
  if (/https?:\/\//i.test(source)) {
    fail(
      `${relative(root, file)} contains a host literal; use trusted downstream configuration`,
    );
  }
}

const srcDirectory = join(root, 'src');
const configurationDirectory = join(srcDirectory, 'config');
const cliDirectory = join(srcDirectory, 'cli');
const postgresPoolFactoryPath = join(
  srcDirectory,
  'common',
  'postgres',
  'postgres-pool.ts',
);
for (const file of collectTypeScriptFiles(srcDirectory)) {
  if (
    file.endsWith('.spec.ts') ||
    file.startsWith(configurationDirectory) ||
    file.startsWith(cliDirectory)
  ) {
    continue;
  }

  const source = readFileSync(file, 'utf8');
  if (/\bprocess\.env\b/.test(source)) {
    fail(
      `${relative(root, file)} reads process.env outside the configuration boundary; inject validated configuration instead`,
    );
  }
}

for (const file of collectTypeScriptFiles(srcDirectory)) {
  if (file.endsWith('.spec.ts') || file === postgresPoolFactoryPath) {
    continue;
  }

  const source = readFileSync(file, 'utf8');
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
for (const file of collectTypeScriptFiles(srcDirectory)) {
  const segments = file.split(sep);
  if (segments.includes('infrastructure') || segments.includes('testing')) {
    continue;
  }

  if (PRISMA_CLIENT_SPECIFIER.test(readFileSync(file, 'utf8'))) {
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
for (const file of collectTypeScriptFiles(srcDirectory)) {
  if (
    file.endsWith('.spec.ts') ||
    file.startsWith(secretsInfrastructureDirectory) ||
    file.startsWith(configurationDirectory) ||
    file.startsWith(cliDirectory) ||
    file === secretsModulePath
  ) {
    continue;
  }

  const source = readFileSync(file, 'utf8');
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

for (const file of collectTypeScriptFiles(srcDirectory)) {
  if (file.endsWith('.spec.ts') || !file.includes(`${sep}presentation${sep}`)) {
    continue;
  }

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
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

if (process.exitCode !== undefined) {
  process.exit(process.exitCode);
}

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
// ADR-0066 / #674: an inner layer must not augment the web framework's
// request type. dependency-cruiser cannot see `declare module`, so check the
// source text directly.
for (const layer of ['application', 'domain']) {
  for (const file of collectTypeScriptFiles(srcDirectory)) {
    if (file.endsWith('.spec.ts')) continue;
    const relativePath = relative(root, file).replace(/\\/g, '/');
    if (!relativePath.includes(`/${layer}/`)) continue;
    const source = readFileSync(file, 'utf8');
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
for (const file of collectTypeScriptFiles(srcDirectory)) {
  const relativePath = relative(root, file).replace(/\\/g, '/');
  if (!relativePath.includes('/application/')) continue;
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/export\s+(?:type|interface)\s+(\w+)/g)) {
    applicationTypeNames.add(match[1]);
  }
}

for (const file of collectTypeScriptFiles(srcDirectory)) {
  const relativePath = relative(root, file).replace(/\\/g, '/');
  if (!relativePath.includes('/infrastructure/')) continue;
  if (file.endsWith('.spec.ts')) continue;
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/as\s+unknown\s+as\s+(\w+)/g)) {
    const typeName = match[1];
    if (!applicationTypeNames.has(typeName)) continue;
    if (CAST_ALLOWLIST.has(`${relativePath}::${typeName}`)) continue;
    fail(
      `${relativePath}: \`as unknown as ${typeName}\` casts an application-declared type in infrastructure; introduce a thin adapter instead.`,
    );
  }
}

const result = spawnSync(
  command,
  [
    'exec',
    'depcruise',
    '--config',
    '.dependency-cruiser.cjs',
    '--output-type',
    'err-long',
    'src',
  ],
  { cwd: root, shell: process.platform === 'win32', stdio: 'inherit' },
);

if (result.error) {
  console.error(`Could not start dependency-cruiser: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
