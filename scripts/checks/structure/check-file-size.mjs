#!/usr/bin/env node
/**
 * Source file length ceiling (ADR-0110): hand-written source files are capped
 * at 500 code lines (blank lines and comments excluded). Composition roots,
 * single-schema configuration, and catalogues are exempt with stated reasons.
 * The historical grandfather list was removed when its tracked splits landed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const srcDir = join(root, 'src');

/** @param {string} dir @returns {string[]} */
function collectFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(p));
    else if (
      entry.isFile() &&
      p.endsWith('.ts') &&
      !p.endsWith('.spec.ts') &&
      !p.includes(`${pathSep()}testing${pathSep()}`)
    )
      out.push(p);
  }
  return out;
}
/** @returns {string} */
function pathSep() {
  return process.platform === 'win32' ? '\\\\' : '/';
}

/** @param {string} file @returns {number} */
function codeLines(file) {
  let n = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (
      s.startsWith('//') ||
      s.startsWith('/*') ||
      s.startsWith('*') ||
      s.startsWith('*/')
    )
      continue;
    n += 1;
  }
  return n;
}

const CEILING = 500;

// Exempt by design (ADR-0110); no ceiling.
/** @type {Map<string, string>} */
const exempt = new Map([
  ['src/modules/identity/identity.module.ts', 'composition root'],
  [
    'src/config/runtime-configuration.ts',
    'single-schema configuration (ADR-0075)',
  ],
  ['src/catalog/public-routes.ts', 'route catalogue'],
]);

/** @param {string} rel @param {number} lines @returns {string | undefined} */
function violation(rel, lines) {
  if (exempt.has(rel)) return undefined;
  return lines > CEILING
    ? `${lines} code lines exceeds the ${CEILING}-line ceiling (ADR-0110).`
    : undefined;
}

let failed = false;
for (const file of collectFiles(srcDir)) {
  const rel = relative(root, file).replace(/\\/g, '/');
  if (rel.includes('/generated/')) continue;
  const message = violation(rel, codeLines(file));
  if (message) {
    console.error(`${rel}: ${message}`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
else console.log('File-size ceiling check passed.');
