import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const TEMP_ROOT = join(REPO_ROOT, 'temp');
const DECLARATION = /^API-Breaking-Change:\s*intentional\s*$/im;
const REASON = /^API-Breaking-Change-Reason:\s*([^\r\n]+)\s*$/im;

function normalizeLegacyTuples(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      normalizeLegacyTuples(item, `${path}/${index}`),
    );
    return;
  }
  if (value === null || typeof value !== 'object') return;

  if (value.type === 'array' && Array.isArray(value.items)) {
    const items = value.items;
    const tupleLength = items.length;
    if (
      tupleLength === 0 ||
      items.some((item) => !isDeepStrictEqual(item, items[0])) ||
      (value.minItems !== undefined && value.minItems !== tupleLength) ||
      (value.maxItems !== undefined && value.maxItems !== tupleLength) ||
      (value.additionalItems !== undefined && value.additionalItems !== false)
    ) {
      throw new Error(`Cannot safely normalize tuple schema at ${path}`);
    }

    // shortcut: only homogeneous TypeBox tuples are normalized; replace this when oasdiff accepts JSON Schema 2020-12 prefixItems.
    value.items = items[0];
    value.minItems = tupleLength;
    value.maxItems = tupleLength;
    delete value.additionalItems;
  }

  for (const [key, child] of Object.entries(value)) {
    normalizeLegacyTuples(child, `${path}/${key}`);
  }
}

function readOpenApi(path) {
  const document = JSON.parse(readFileSync(resolve(path), 'utf8'));
  normalizeLegacyTuples(document);
  return document;
}

function breakingReason(body) {
  if (!DECLARATION.test(body)) return undefined;
  return REASON.exec(body)?.[1]?.trim() || undefined;
}

function parseChanges(stdout) {
  const changes = JSON.parse(stdout);
  if (
    !Array.isArray(changes) ||
    changes.length === 0 ||
    !changes.some(
      (change) =>
        change !== null &&
        typeof change === 'object' &&
        typeof change.level === 'number' &&
        change.level >= 2,
    )
  ) {
    throw new Error('oasdiff returned an unexpected breaking-change result');
  }
  return changes;
}

function cleanTempRoot() {
  try {
    rmdirSync(TEMP_ROOT);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

function main() {
  const [basePath, revisionPath, ...extraArgs] = process.argv.slice(2);
  if (!basePath || !revisionPath || extraArgs.length > 0) {
    throw new Error(
      'Usage: node scripts/ci/api-compatibility/check.mjs <base-openapi.json> <candidate-openapi.json>',
    );
  }

  const base = readOpenApi(basePath);
  const revision = readOpenApi(revisionPath);
  mkdirSync(TEMP_ROOT, { recursive: true });
  const scratch = mkdtempSync(join(TEMP_ROOT, 'api-compatibility-'));

  try {
    const normalizedBase = join(scratch, 'base.json');
    const normalizedRevision = join(scratch, 'revision.json');
    writeFileSync(normalizedBase, JSON.stringify(base));
    writeFileSync(normalizedRevision, JSON.stringify(revision));

    const comparison = spawnSync(
      process.env.OASDIFF_BIN ?? 'oasdiff',
      [
        'breaking',
        normalizedBase,
        normalizedRevision,
        '--format',
        'json',
        '--fail-on',
        'WARN',
        '--allow-external-refs=false',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );

    if (comparison.error) throw comparison.error;
    if (comparison.status === 0) {
      process.stdout.write('No breaking API contract changes.\n');
      return;
    }
    if (comparison.status !== 1) {
      throw new Error(
        `oasdiff failed with exit code ${comparison.status}:\n${comparison.stderr || comparison.stdout}`,
      );
    }

    const changes = parseChanges(comparison.stdout);
    const details = changes.map((change) => `- ${change.text}`).join('\n');
    const reason = breakingReason(process.env.PR_BODY ?? '');
    if (reason !== undefined) {
      process.stdout.write(
        `Intentional breaking change declared: ${reason}\n${details}\n`,
      );
      return;
    }

    throw new Error(
      `Breaking API contract changes detected:\n${details}\n\nTo declare an intentional break, add these lines to the pull request description:\nAPI-Breaking-Change: intentional\nAPI-Breaking-Change-Reason: <non-empty explanation>`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    cleanTempRoot();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
