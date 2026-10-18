#!/usr/bin/env node
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
    else if (entry.isFile() && p.endsWith('.ts') && !p.endsWith('.spec.ts'))
      out.push(p);
  }
  return out;
}

const patterns = [
  { name: 'Date.now()', re: /\bDate\.now\s*\(\s*\)/ },
  { name: 'new Date() without argument', re: /\bnew\s+Date\s*\(\s*\)/ },
  { name: 'Math.random()', re: /\bMath\.random\s*\(\s*\)/ },
  { name: 'fetch', re: /\bfetch\s*\(/ },
  { name: 'crypto.randomUUID()', re: /\bcrypto\.randomUUID\s*\(\s*\)/ },
  { name: 'process.*', re: /\bprocess\.\w+/ },
];

let failed = false;
for (const file of collectFiles(srcDir)) {
  const rel = relative(root, file).replace(/\\/g, '/');
  if (!rel.includes('/domain/')) continue;
  const source = readFileSync(file, 'utf8');
  for (const { name, re } of patterns) {
    if (re.test(source)) {
      console.error(
        `${rel}: bare global \`${name}\` is forbidden in domain code (ADR-0090 / #807).`,
      );
      failed = true;
    }
  }
}

if (failed) process.exitCode = 1;
else console.log('Domain bare-globals check passed.');
