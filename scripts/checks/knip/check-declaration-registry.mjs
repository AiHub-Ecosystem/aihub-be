#!/usr/bin/env node
/**
 * Hand-written declaration registry (#1787): every `.d.cts`/`.d.mts` file in
 * the repository that types a plain-JavaScript sibling is hand-maintained, and
 * so is the `knip.json` `entry` that keeps knip from reporting that sibling as
 * unused. Nothing kept the two sides in agreement by construction, so an entry
 * could name a file that had been deleted, or a file could appear with no
 * entry, and only a later `knip` run would say so — often after the comment
 * trailing the entry had already drifted.
 *
 * The fix is a check that fails on drift rather than regenerating either side:
 *
 *   - every hand-written declaration in the tree is listed in `knip.json`'s
 *     `entry`, and every `entry` naming a declaration points at a file that
 *     exists;
 *   - every such entry carries a one-line reason comment, the way the other
 *     gates in `scripts/checks/` require a stated reason;
 *   - the exemption is recorded here, once, instead of restated per entry.
 *
 * Knip's own resolution decides nothing here: this reads the filesystem and the
 * configuration text, so it fails the same way whether or not knip's cache is
 * warm.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The tree the gate measures. `process.cwd()` is what the gate uses when run as
 * a package script, and what its spec points at a fixture tree, the way the
 * folder-entry check reads its own cwd; the module location is only the
 * fallback for a caller that has neither.
 * @param {string} [root]
 * @returns {string}
 */
function rootFor(root) {
  return resolve(root ?? process.cwd() ?? REPO_ROOT);
}

/** Extensions of the hand-written declarations this gate tracks. */
const DECLARATION = /\.d\.(?:cts|mts)$/u;

/**
 * Declarations TypeScript finds without a knip entry, because the module they
 * type sits at the same path: `.dependency-cruiser.d.cts` annotates
 * `.dependency-cruiser.cjs`, and knip's own resolution already reaches the
 * `.cjs` through `package.json`. Adding an entry for it would be noise, so the
 * exemption is recorded here rather than left to an inline comment.
 */
export const ADJACENT_DECLARATIONS = new Set(['.dependency-cruiser.d.cts']);

/** Directories never walked: not repository source, never declared. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', 'temp']);

/** @typedef {{path: string, reason?: string}} KnipEntry */

/** @param {string} dir @returns {string[]} */
function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Every `.d.cts`/`.d.mts` file under `dir`, as posix-relative paths from the
 * repository root.
 * @param {string} dir @param {string} rel @returns {string[]}
 */
export function collectDeclarations(dir, rel) {
  /** @type {string[]} */
  const found = [];
  for (const name of listDir(dir).sort()) {
    const childRel = rel === '' ? name : `${rel}/${name}`;
    const childAbs = join(dir, name);
    // A directory is probed by listing it; the entries above came from a
    // listing, so a probe that throws is a file.
    const entries = (() => {
      try {
        return readdirSync(childAbs);
      } catch {
        return null;
      }
    })();
    if (entries === null) {
      if (DECLARATION.test(name)) found.push(childRel);
      continue;
    }
    if (SKIP_DIRS.has(name)) continue;
    found.push(...collectDeclarations(childAbs, childRel));
  }
  return found;
}

/**
 * The `entry` array of `knip.json` with the reason comment standing directly
 * above each element. The file is JSONC by house style, so this reads it as
 * text: a JSON parse would drop exactly the comments the gate exists to
 * enforce.
 * @param {string} source
 * @returns {KnipEntry[]}
 */
export function parseKnipEntries(source) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => /"entry"\s*:\s*\[/u.test(line));
  if (start === -1) throw new Error('knip.json has no "entry" array');

  /** @type {KnipEntry[]} */
  const entries = [];
  /** @type {string[]} */
  let pending = [];
  /** @type {true | undefined} */
  let inBlockComment;
  for (const line of lines.slice(start + 1)) {
    const text = line.trim();
    if (text.startsWith(']')) break;

    if (inBlockComment) {
      pending.push(text.replace(/^\/?\*+\/?/u, '').trim());
      if (text.includes('*/')) inBlockComment = undefined;
      continue;
    }
    if (text.startsWith('/*')) {
      pending.push(
        text
          .replace(/^\/\*+/u, '')
          .replace(/\*\/$/u, '')
          .trim(),
      );
      if (!text.includes('*/')) inBlockComment = true;
      continue;
    }
    if (text.startsWith('//')) {
      pending.push(text.replace(/^\/+/u, '').trim());
      continue;
    }

    const value = /^"(?<path>[^"]+)"/u.exec(text)?.groups?.path;
    if (value === undefined) {
      // A blank line ends an element either way: a comment separated from its
      // entry by one is not that entry's reason.
      if (text === '') pending = [];
      continue;
    }
    const reason = pending.join(' ').trim();
    entries.push(reason === '' ? { path: value } : { path: value, reason });
    pending = [];
  }
  return entries;
}

/** A bullet list of paths, for the message that names what drifted. */
/** @param {string[]} paths @returns {string} */
function asBulletList(paths) {
  return paths.map((path) => `  - ${path}`).join('\n');
}

/**
 * The drift a declaration/entry pair reports, and the message describing it.
 * @param {{
 *   declarations: string[],
 *   entries: KnipEntry[],
 *   exists?: (path: string) => boolean,
 *   exempt?: Set<string>,
 * }} input
 * @returns {{failures: string[], tracked: number}}
 */
export function evaluateRegistry({
  declarations,
  entries,
  exists = (path) => existsSync(join(REPO_ROOT, path)),
  exempt = ADJACENT_DECLARATIONS,
}) {
  /** @type {string[]} */
  const failures = [];
  const declarationEntries = entries.filter((entry) =>
    DECLARATION.test(entry.path),
  );
  const entryPaths = new Set(declarationEntries.map((entry) => entry.path));
  const tracked = declarations.filter((path) => !exempt.has(path));

  const missingEntries = tracked.filter((path) => !entryPaths.has(path));
  if (missingEntries.length > 0) {
    failures.push(
      `hand-written declarations with no knip.json entry:\n${asBulletList(missingEntries)}\n` +
        'Add each to the "entry" array with a reason comment, or record why it needs none',
    );
  }

  const missingFiles = declarationEntries
    .map((entry) => entry.path)
    .filter((path) => !exists(path));
  if (missingFiles.length > 0) {
    failures.push(
      `knip.json entries naming a declaration that does not exist:\n${asBulletList(missingFiles)}\n` +
        'Delete the entry, or restore the file it describes',
    );
  }

  const undocumented = declarationEntries
    .filter((entry) => entry.reason === undefined)
    .map((entry) => entry.path);
  if (undocumented.length > 0) {
    failures.push(
      `knip.json entries carrying no reason comment:\n${asBulletList(undocumented)}\n` +
        'Put a one-line reason on the comment line directly above each entry',
    );
  }

  // An exemption for a file that no longer exists is drift too, but only when
  // the module it types is still there: that is the case where the exemption
  // silently excuses a path nothing covers. An exemption whose module is gone
  // as well is a leftover this gate reports through the declaration walk, not
  // here.
  const staleExemptions = [...exempt].filter(
    (path) =>
      !declarations.includes(path) && exists(path.replace(DECLARATION, '')),
  );
  if (staleExemptions.length > 0) {
    failures.push(
      `exempt declarations that no longer exist:\n${asBulletList(staleExemptions)}\n` +
        'Remove each from ADJACENT_DECLARATIONS',
    );
  }

  return { failures, tracked: tracked.length };
}

/** @param {string} [root] @returns {{failures: string[], tracked: number}} */
export function checkRepository(root) {
  const base = rootFor(root);
  // The walk starts with an empty relative prefix, so every path it yields is
  // relative to the measured tree and matches the spelling knip.json uses.
  const declarations = collectDeclarations(base, '');
  const entries = parseKnipEntries(
    readFileSync(join(base, 'knip.json'), 'utf8'),
  );
  return evaluateRegistry({
    declarations,
    entries,
    exists: (path) => existsSync(join(base, path)),
  });
}

function run() {
  let outcome;
  try {
    outcome = checkRepository();
  } catch (error) {
    process.stderr.write(
      `declaration-registry: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (outcome.failures.length > 0) {
    for (const failure of outcome.failures) {
      process.stderr.write(`declaration-registry: ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }
  const plural = outcome.tracked === 1 ? 'declaration' : 'declarations';
  console.log(
    `Declaration-registry check passed: ${outcome.tracked} hand-written ${plural} each have one knip.json entry with a stated reason.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run();
