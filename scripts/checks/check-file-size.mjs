#!/usr/bin/env node
/**
 * Source file length ceiling (ADR-0110): hand-written source files are capped
 * at 500 code lines (blank lines and comments excluded). Composition roots,
 * single-schema configuration, and catalogues are exempt with stated reasons;
 * the existing oversized files are grandfathered behind the allowlist below
 * and carry a `ponytail:` header comment until refactored.
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

const allowlist = new Set([
  'src/openapi/build-openapi-document.ts',
  'src/postman/build-postman-collection.ts',
  'src/modules/identity/membership/infrastructure/postgres-organization-membership.repository.ts',
  'src/modules/auth/email-delivery/infrastructure/postgres-email-delivery-request.repository.ts',
  'src/modules/identity/user-assertions/infrastructure/jwks-key-provider.ts',
  'src/modules/identity/invitations/infrastructure/postgres-organization-invitation.repository.ts',
  'src/modules/identity/identity.module.ts',
  'src/config/runtime-configuration.ts',
  'src/catalog/public-routes.ts',
]);

let failed = false;
for (const file of collectFiles(srcDir)) {
  const rel = relative(root, file).replace(/\\/g, '/');
  if (rel.includes('/generated/')) continue;
  if (codeLines(file) > 500 && !allowlist.has(rel)) {
    console.error(
      `${rel}: ${codeLines(file)} code lines exceeds the 500-line ceiling (ADR-0110).`,
    );
    failed = true;
  }
}

if (failed) process.exitCode = 1;
else console.log('File-size ceiling check passed.');
