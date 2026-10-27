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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const TEMP_ROOT = join(REPO_ROOT, 'temp');

/** @typedef {{level: number, text: string}} ApiChange */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {unknown} value @returns {value is ApiChange} */
function isApiChange(value) {
  return (
    isRecord(value) &&
    typeof value.level === 'number' &&
    typeof value.text === 'string'
  );
}

/** @param {unknown} value @param {string} [path] */
export function normalizeLegacyTuples(value, path = '$') {
  if (Array.isArray(value)) {
    /** @type {unknown[]} */
    const items = value;
    items.forEach((item, index) =>
      normalizeLegacyTuples(item, `${path}/${index}`),
    );
    return;
  }
  if (!isRecord(value)) return;

  const tupleItems = value.items;
  if (value.type === 'array' && Array.isArray(tupleItems)) {
    /** @type {unknown[]} */
    const items = tupleItems;
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

/** @param {string} path @returns {unknown} */
function readOpenApi(path) {
  const document = /** @type {unknown} */ (
    JSON.parse(readFileSync(resolve(path), 'utf8'))
  );
  normalizeLegacyTuples(document);
  return document;
}

/** @param {string} stdout @returns {ApiChange[]} */
export function parseChanges(stdout) {
  const parsed = /** @type {unknown} */ (JSON.parse(stdout));
  if (!Array.isArray(parsed)) {
    throw new Error('oasdiff returned an unexpected breaking-change result');
  }
  const entries = /** @type {unknown[]} */ (parsed);
  const changes = entries.filter(isApiChange);
  if (
    changes.length === 0 ||
    changes.length !== entries.length ||
    !changes.some((change) => change.level >= 2)
  ) {
    throw new Error('oasdiff returned an unexpected breaking-change result');
  }
  return changes;
}

/** @param {unknown} base @param {unknown} revision @returns {ApiChange[]} */
export function findBreakingChanges(base, revision) {
  normalizeLegacyTuples(base);
  normalizeLegacyTuples(revision);
  mkdirSync(TEMP_ROOT, { recursive: true });
  const scratch = mkdtempSync(join(TEMP_ROOT, 'api-compatibility-'));

  try {
    const basePath = join(scratch, 'base.json');
    const revisionPath = join(scratch, 'revision.json');
    writeFileSync(basePath, JSON.stringify(base));
    writeFileSync(revisionPath, JSON.stringify(revision));

    const comparison = spawnSync(
      process.env.OASDIFF_BIN ?? 'oasdiff',
      [
        'breaking',
        basePath,
        revisionPath,
        '--format',
        'json',
        '--fail-on',
        'WARN',
        '--allow-external-refs=false',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );

    if (comparison.error) throw comparison.error;
    if (comparison.status === 0) return [];
    if (comparison.status !== 1) {
      throw new Error(
        `oasdiff failed with exit code ${comparison.status}:\n${comparison.stderr || comparison.stdout}`,
      );
    }
    return parseChanges(comparison.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    cleanTempRoot();
  }
}

/** @param {unknown} error */
function ignoreExpectedTempRootError(error) {
  const code = isRecord(error) ? error.code : undefined;
  if (
    typeof code === 'string' &&
    ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code)
  ) {
    return;
  }
  throw error;
}

function cleanTempRoot() {
  try {
    rmdirSync(TEMP_ROOT);
  } catch (error) {
    ignoreExpectedTempRootError(error);
  }
}

/** @returns {void} */
function main() {
  const [basePath, revisionPath, ...extraArgs] = process.argv.slice(2);
  if (!basePath || !revisionPath || extraArgs.length > 0) {
    throw new Error(
      'Usage: node scripts/ci/api-compatibility/check.mjs <base-openapi.json> <candidate-openapi.json>',
    );
  }

  const base = readOpenApi(basePath);
  const revision = readOpenApi(revisionPath);
  const changes = findBreakingChanges(base, revision);
  if (changes.length === 0) {
    process.stdout.write('No breaking API contract changes.\n');
    return;
  }

  const details = changes.map((change) => `- ${change.text}`).join('\n');
  throw new Error(`Breaking API contract changes detected:\n${details}`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : '';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
