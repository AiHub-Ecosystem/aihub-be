import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
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
const secretsInfrastructureDirectory = join(
  srcDirectory,
  'modules',
  'secrets',
  'infrastructure',
);
for (const file of collectTypeScriptFiles(srcDirectory)) {
  if (
    file.endsWith('.spec.ts') ||
    file.startsWith(secretsInfrastructureDirectory)
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

if (process.exitCode !== undefined) {
  process.exit(process.exitCode);
}

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
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
