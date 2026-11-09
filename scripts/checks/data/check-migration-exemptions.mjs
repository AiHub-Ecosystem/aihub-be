#!/usr/bin/env node
/**
 * Squawk's exemption list is for history only (#1810): `.squawk.toml` names
 * every applied migration in `excluded_paths` by exact path, because a rule
 * that landed after a migration was applied has no way to reach it.
 *
 * What nothing enforced was that the list stops where history stops. Three
 * consequences followed:
 *
 *   - a new migration that trips a squawk rule was exempted by appending one
 *     more line to `excluded_paths`; CI went green and the diff was
 *     indistinguishable from the historical entries around it;
 *   - nothing distinguished an exemption for history from an exemption for
 *     code still being written, because no cutoff was asserted;
 *   - the list could grow to cover every migration, at which point squawk
 *     checked zero files and still printed `Found 0 issues`.
 *
 * The rule this gate enforces: an exemption may name a migration at or below
 * the declared historical baseline, and it must name one that exists. Moving
 * the baseline forward is then a deliberate, visible act rather than a side
 * effect of adding an entry.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The highest migration number whose exemption is historical, declared once
 * with its reason. `0040` was the last migration already applied in Production
 * and Sandbox when the list was written; every exemption above it would be a
 * migration still in flight.
 */
export const HISTORICAL_BASELINE = 40;

/**
 * The tree the gate measures. `process.cwd()` is what the gate uses when run as
 * a package script, and what its spec points at a fixture tree; the module
 * location is only the fallback for a caller that has neither.
 * @param {string} [root]
 * @returns {string}
 */
function rootFor(root) {
  return resolve(root ?? process.cwd() ?? REPO_ROOT);
}

/** A Prisma migration directory name: a numeric prefix and a snake_case label. */
const MIGRATION_DIR = /^(?<number>\d+)_[a-z0-9_]+$/u;

/**
 * The `excluded_paths` array of `.squawk.toml`, read as text because the file
 * is TOML with comments beside the values this gate must not lose.
 * @param {string} source
 * @returns {string[]}
 */
export function parseExcludedPaths(source) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) =>
    /^\s*excluded_paths\s*=\s*\[/u.test(line),
  );
  if (start === -1) throw new Error('.squawk.toml has no excluded_paths array');

  /** @type {string[]} */
  const paths = [];
  for (const line of lines.slice(start + 1)) {
    const text = line.trim();
    if (text.startsWith(']')) break;
    // A trailing `#` comment may follow the closing quote.
    const value = /^"(?<path>[^"]+)"/u.exec(text)?.groups?.['path'];
    if (value !== undefined) paths.push(value);
  }
  return paths;
}

/**
 * The migration number an excluded path names, or `undefined` when the path is
 * not a `prisma/migrations/<dir>/migration.sql` shape this gate can reason
 * about. Such a path is reported separately rather than silently skipped.
 * @param {string} path
 * @returns {number | undefined}
 */
export function migrationNumberOf(path) {
  const match = /^prisma\/migrations\/(?<dir>[^/]+)\/migration\.sql$/u.exec(
    path,
  );
  const dir = match === null ? undefined : (match.groups?.['dir'] ?? undefined);
  if (dir === undefined) return undefined;
  const number = MIGRATION_DIR.exec(dir)?.groups?.['number'];
  return number === undefined ? undefined : Number(number);
}

/**
 * Every migration directory in the tree, as a set of `prisma/migrations/<dir>`
 * prefixes, so an entry naming a migration that was deleted can be reported.
 * @param {string} migrationsDir
 * @returns {Set<string>}
 */
function collectMigrationDirs(migrationsDir) {
  /** @type {Set<string>} */
  const found = new Set();
  let entries;
  try {
    entries = readdirSync(migrationsDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    found.add(entry.name);
  }
  return found;
}

/**
 * The failures an exemption list reports, and how many exemptions were checked.
 * @param {{
 *   excludedPaths: string[],
 *   migrationDirs?: Set<string>,
 *   exists?: (path: string) => boolean,
 *   baseline?: number,
 * }} input
 * @returns {{failures: string[], checked: number}}
 */
export function evaluateExemptions({
  excludedPaths,
  migrationDirs,
  exists = (path) => existsSync(join(REPO_ROOT, path)),
  baseline = HISTORICAL_BASELINE,
}) {
  /** @type {string[]} */
  const failures = [];

  const unrecognised = excludedPaths.filter(
    (path) => migrationNumberOf(path) === undefined,
  );
  if (unrecognised.length > 0) {
    failures.push(
      `excluded_paths entries that are not prisma/migrations/<number>_<label>/migration.sql:\n${unrecognised
        .map((path) => `  - ${path}`)
        .join('\n')}\n` +
        'Name the exact migration path, or explain why the entry is not a migration',
    );
  }

  const beyondBaseline = excludedPaths.filter((path) => {
    const number = migrationNumberOf(path);
    return number !== undefined && number > baseline;
  });
  if (beyondBaseline.length > 0) {
    failures.push(
      `exempted migrations newer than the declared historical baseline (${String(baseline).padStart(4, '0')}):\n${beyondBaseline
        .map((path) => `  - ${path}`)
        .join('\n')}\n` +
        'An exemption is for applied history only. Fix the migration so it passes squawk, ' +
        'or raise HISTORICAL_BASELINE in a separate, visible change once that migration is applied',
    );
  }

  const missing = excludedPaths.filter((path) => {
    if (migrationDirs === undefined) return !exists(path);
    const dir = /^prisma\/migrations\/(?<dir>[^/]+)\//u.exec(path)?.groups?.[
      'dir'
    ];
    return dir === undefined || !migrationDirs.has(dir);
  });
  if (missing.length > 0) {
    failures.push(
      `excluded_paths entries naming a migration that does not exist:\n${missing
        .map((path) => `  - ${path}`)
        .join('\n')}\n` +
        'Delete the exemption, or restore the migration it names',
    );
  }

  return { failures, checked: excludedPaths.length };
}

/**
 * Read the repository's own exemption list and report each migration it
 * exempts. Exported for the spec; the CLI below is the only caller in the gate.
 * @param {string} root
 * @returns {{failures: string[], checked: number}}
 */
export function checkRepository(root = rootFor()) {
  const configPath = join(root, '.squawk.toml');
  const source = readFileSync(configPath, 'utf8');
  const excludedPaths = parseExcludedPaths(source);
  const migrationDirs = collectMigrationDirs(
    join(root, 'prisma', 'migrations'),
  );
  return evaluateExemptions({
    excludedPaths,
    migrationDirs,
    exists: (path) => existsSync(join(root, path)),
  });
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { failures, checked } = checkRepository();
  if (failures.length > 0) {
    for (const failure of failures) console.error(`\n${failure}`);
    console.error('');
    process.exitCode = 1;
  } else {
    console.log(
      `Migration exemption check passed: ${String(checked)} historical exclusions, none beyond the baseline.`,
    );
  }
}
