#!/usr/bin/env node
/**
 * Folder-entry ceilings (#1347): the folder sizes AGENTS.md states as rules
 * are measured here, so the rule cannot drift silently the way scripts/checks
 * did between #566 and #1770.
 *
 * Scope, recorded here and in AGENTS.md so "each root" is not ambiguous:
 *   - 15-entry ceiling: the six scripts roots (scripts/{cli,ops,generate,
 *     checks,ci,runtime}) and the test roots the grouping sentence names
 *     (test/, test/cli/, test/integration/).
 *   - 20-entry ceiling: every layer folder under src/modules/ — a directory
 *     named application, domain, infrastructure, presentation or public at
 *     any depth — plus each direct feature subfolder of a layer folder, the
 *     way the Gateway and Metering ceilings are stated since #1555.
 *
 * Over-ceiling folders are grandfathered only through the explicit allowlist
 * below. An entry is a debt record, not a permission to grow: it pins the
 * count the folder held when it was recorded, the live count is printed on
 * every run, and a folder that gains entries past its baseline fails. The
 * allowlist is expected to shrink as the tracked reductions land — it is
 * empty since #1770 brought scripts/checks back under the ceiling — and a
 * folder measured back within its ceiling while still listed is reported for
 * removal.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SCRIPTS_CEILING = 15;
export const LAYER_CEILING = 20;

/** The six scripts roots and the test roots the grouping sentence names. */
export const MEASURED_ROOTS = [
  'scripts/ci',
  'scripts/cli',
  'scripts/generate',
  'scripts/checks',
  'scripts/ops',
  'scripts/runtime',
  'test',
  'test/cli',
  'test/integration',
];

export const LAYER_DIRS = new Set([
  'application',
  'domain',
  'infrastructure',
  'presentation',
  'public',
]);

/**
 * Grandfathered over-ceiling folders. The baseline pins the direct-entry
 * count the folder held when it was recorded; growth past it fails.
 *
 * FOLDER_ENTRIES_ALLOWLIST lets the spec inject entries around the static
 * map: it is test-only wiring, and a malformed value fails the run rather
 * than being ignored.
 * @type {Map<string, {baseline: number, note: string}>}
 */
export const ALLOWLIST = new Map();

/** @returns {Map<string, {baseline: number, note: string}>} */
export function allowlistForRun() {
  const raw = process.env.FOLDER_ENTRIES_ALLOWLIST;
  if (!raw) return ALLOWLIST;
  const injected =
    /** @type {Record<string, {baseline: number, note: string}>} */ (
      JSON.parse(raw)
    );
  return new Map([...ALLOWLIST, ...Object.entries(injected)]);
}

/** @param {string} dir @returns {string[]} */
function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Every layer folder under src/modules/ and every direct feature subfolder of
 * one, as posix-relative paths. A directory whose own name is a layer name is
 * measured at any depth; a directory whose parent is a layer folder is the
 * feature subfolder the Gateway and Metering rule caps.
 * @param {string} dir @param {string} rel @returns {string[]}
 */
export function collectLayerFolders(dir, rel) {
  /** @type {string[]} */
  const out = [];
  const parentIsLayer = LAYER_DIRS.has(rel.split('/').pop() ?? '');
  for (const entry of listDir(dir)) {
    const child = join(dir, entry);
    const childRel = `${rel}/${entry}`;
    try {
      readdirSync(child, { withFileTypes: true });
    } catch {
      continue; // a file, not a directory
    }
    if (LAYER_DIRS.has(entry) || parentIsLayer) out.push(childRel);
    out.push(...collectLayerFolders(child, childRel));
  }
  return out;
}

/**
 * The outcome one measured folder produces and the message to report.
 * @param {{
 *   folder: string,
 *   count: number,
 *   ceiling: number,
 *   allowlisted?: {baseline: number, note: string},
 * }} input
 * @returns {{
 *   outcome: 'ok' | 'shrink' | 'grandfathered' | 'over' | 'grew',
 *   message: string,
 * }}
 */
export function evaluateFolder({ folder, count, ceiling, allowlisted }) {
  const rule =
    ceiling === SCRIPTS_CEILING
      ? 'AGENTS.md: "Keep each root at 15 direct entries or fewer"'
      : 'AGENTS.md: layer folders under src/modules/ hold 20 direct entries or fewer';
  const over = `${folder} holds ${count} direct entries against the ${ceiling}-entry ceiling (${rule})`;
  if (count <= ceiling) {
    return allowlisted
      ? {
          outcome: 'shrink',
          message: `${folder} is back within its ceiling at ${count} direct entries; remove it from the allowlist`,
        }
      : { outcome: 'ok', message: '' };
  }
  if (!allowlisted) return { outcome: 'over', message: over };
  if (count > allowlisted.baseline)
    return {
      outcome: 'grew',
      message: `${over}; it is grandfathered at ${allowlisted.baseline} (${allowlisted.note}) and may not grow`,
    };
  return {
    outcome: 'grandfathered',
    message: `${folder} is grandfathered at ${count} direct entries against its ceiling (${allowlisted.note})`,
  };
}

function run() {
  const root = process.cwd();
  let failed = false;
  /** @param {{outcome: string, message: string}} result */
  const report = ({ outcome, message }) => {
    if (outcome === 'ok') return;
    if (outcome === 'over' || outcome === 'grew') {
      process.stderr.write(`folder-entries: ${message}\n`);
      failed = true;
    } else {
      process.stdout.write(`folder-entries: ${message}\n`);
    }
  };
  const allowlist = allowlistForRun();
  for (const folder of MEASURED_ROOTS)
    report(
      evaluateFolder({
        folder,
        count: listDir(join(root, folder)).length,
        ceiling: SCRIPTS_CEILING,
        allowlisted: allowlist.get(folder),
      }),
    );
  for (const rel of collectLayerFolders(
    join(root, 'src/modules'),
    'src/modules',
  ))
    report(
      evaluateFolder({
        folder: rel,
        count: listDir(join(root, rel)).length,
        ceiling: LAYER_CEILING,
        allowlisted: allowlist.get(rel),
      }),
    );
  if (failed) {
    process.stderr.write(
      'folder-entries: split the folder by concern or record it in the allowlist with a tracked reduction\n',
    );
    process.exitCode = 1;
  } else {
    console.log('Folder-entry ceiling check passed.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run();
