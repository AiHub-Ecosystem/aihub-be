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
 * below, the way check:file-size grandfathers oversized files. An entry is a
 * debt record, not a permission to grow: it pins the count the folder held
 * when it was recorded, the live count is printed on every run, and a folder
 * that gains entries past its baseline fails. The allowlist is expected to
 * shrink as the tracked reductions land; a folder measured back within its
 * ceiling while still listed is reported for removal.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const SCRIPTS_CEILING = 15;
const LAYER_CEILING = 20;

/** The six scripts roots and the test roots the grouping sentence names. */
const MEASURED_ROOTS = [
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

const LAYER_DIRS = new Set([
  'application',
  'domain',
  'infrastructure',
  'presentation',
  'public',
]);

/**
 * Grandfathered over-ceiling folders. The baseline pins the direct-entry
 * count the folder held when it was recorded; growth past it fails.
 * @type {Map<string, {baseline: number, note: string}>}
 */
const ALLOWLIST = new Map([
  [
    'scripts/checks',
    {
      baseline: 62,
      note: '#1770 tracks the reduction; recorded when this gate landed',
    },
  ],
]);

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
function collectLayerFolders(dir, rel) {
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

/** @param {string} folder @param {number} count @param {number} ceiling @returns {string} */
function violation(folder, count, ceiling) {
  const rule =
    ceiling === SCRIPTS_CEILING
      ? 'AGENTS.md: "Keep each root at 15 direct entries or fewer"'
      : 'AGENTS.md: layer folders under src/modules/ hold 20 direct entries or fewer';
  return `${folder} holds ${count} direct entries against the ${ceiling}-entry ceiling (${rule})`;
}

const root = process.cwd();
let failed = false;

/** @param {string} folder @param {number} count @param {number} ceiling */
function measure(folder, count, ceiling) {
  const listed = ALLOWLIST.get(folder);
  if (count <= ceiling) {
    if (listed)
      process.stdout.write(
        `folder-entries: ${folder} is back within its ceiling at ${count} direct entries; remove it from the allowlist\n`,
      );
    return;
  }
  if (!listed) {
    process.stderr.write(
      `folder-entries: ${violation(folder, count, ceiling)}\n`,
    );
    failed = true;
    return;
  }
  if (count > listed.baseline) {
    process.stderr.write(
      `folder-entries: ${violation(folder, count, ceiling)}; it is grandfathered at ${listed.baseline} (${listed.note}) and may not grow\n`,
    );
    failed = true;
    return;
  }
  process.stdout.write(
    `folder-entries: ${folder} is grandfathered at ${count} direct entries against its ceiling (${listed.note})\n`,
  );
}

for (const folder of MEASURED_ROOTS)
  measure(folder, listDir(join(root, folder)).length, SCRIPTS_CEILING);

for (const rel of collectLayerFolders(join(root, 'src/modules'), 'src/modules'))
  measure(rel, listDir(join(root, rel)).length, LAYER_CEILING);

if (failed) {
  process.stderr.write(
    'folder-entries: split the folder by concern or record it in the allowlist with a tracked reduction\n',
  );
  process.exitCode = 1;
} else {
  console.log('Folder-entry ceiling check passed.');
}
