#!/usr/bin/env node
/**
 * Rejects recovering Organization identity from a module-level (repository-global)
 * variable. Organization identity must arrive through RequestContext or explicit
 * application inputs (AGENTS.md, #763).
 *
 * Scans src/modules for top-level `let`/`var` declarations whose name contains
 * an organization/tenant marker. `const` module-level values are allowed (they
 * cannot be reassigned, so they cannot carry per-request tenant state).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const srcModules = join(root, 'src', 'modules');

// broader: identifier contains org/tenant
const TENANT_IDENT = /(organi[sz]ation|tenant)/i;

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(p));
    else if (entry.isFile() && p.endsWith('.ts') && !p.endsWith('.spec.ts'))
      out.push(p);
  }
  return out;
}

// Allowlist: file path (relative, posix) -> reason
const allowlist = new Set([]);

let failed = false;
for (const file of collectFiles(srcModules)) {
  const rel = relative(root, file).replace(/\\/g, '/');
  if (allowlist.has(rel)) continue;
  const source = readFileSync(file, 'utf8');
  for (const line of source.split(/\r?\n/)) {
    // top-level let/var declaration (not indented inside a function/class)
    const m = /^\s*(export\s+)?(let|var)\s+([A-Za-z_$][\w$]*)\b/.exec(line);
    if (!m) continue;
    const name = m[3];
    if (!TENANT_IDENT.test(name)) continue;
    console.error(
      `${rel}: module-level mutable tenant state \`${name}\` is forbidden; pass Organization identity through RequestContext or application inputs.`,
    );
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('No module-level tenant state found.');
}
