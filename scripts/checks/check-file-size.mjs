#!/usr/bin/env node
/**
 * Source file length ceiling (ADR-0110): hand-written source files are capped
 * at 500 code lines (blank lines and comments excluded). Composition roots,
 * single-schema configuration, and catalogues are exempt with stated reasons.
 * The existing oversized files are grandfathered behind a ratchet (#869): each
 * may shrink but never grow past its recorded count, the count must be lowered
 * when the file shrinks, and the entry must go once the file is back under the
 * ceiling. Each carries a `ponytail:` header linking its split issue.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const srcDir = join(root, 'src');

function collectFiles(dir) {
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
function pathSep() {
  return process.platform === 'win32' ? '\\\\' : '/';
}

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

// Exempt by design (ADR-0110); no ceiling and no ratchet.
const exempt = new Map([
  ['src/modules/identity/identity.module.ts', 'composition root'],
  [
    'src/config/runtime-configuration.ts',
    'single-schema configuration (ADR-0075)',
  ],
  ['src/catalog/public-routes.ts', 'route catalogue'],
]);

// Grandfathered (ADR-0110): recorded code-line count; the split is tracked in
// the issue named in each file's `ponytail:` header.
const grandfathered = new Map([
  ['src/openapi/build-openapi-document.ts', 2130],
  [
    'src/modules/identity/membership/infrastructure/postgres-organization-membership.repository.ts',
    958,
  ],
  [
    'src/modules/auth/email-delivery/infrastructure/postgres-email-delivery-request.repository.ts',
    744,
  ],
  [
    'src/modules/identity/user-assertions/infrastructure/jwks-key-provider.ts',
    818,
  ],
  [
    'src/modules/identity/invitations/infrastructure/postgres-organization-invitation.repository.ts',
    512,
  ],
]);

function violation(rel, lines) {
  if (exempt.has(rel)) return undefined;
  const recorded = grandfathered.get(rel);
  if (recorded === undefined) {
    return lines > CEILING
      ? `${lines} code lines exceeds the ${CEILING}-line ceiling (ADR-0110).`
      : undefined;
  }
  if (lines <= CEILING)
    return `${lines} code lines is back under the ${CEILING}-line ceiling; remove it from the grandfathered list.`;
  if (lines > recorded)
    return `${lines} code lines grew past its grandfathered ${recorded} (ADR-0110); split it instead of growing it.`;
  if (lines < recorded)
    return `${lines} code lines is below its grandfathered ${recorded}; lower the recorded count to ${lines}.`;
  return undefined;
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
