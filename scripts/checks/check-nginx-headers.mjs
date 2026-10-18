#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const dir = join(root, 'ops', 'nginx');
let failed = false;
for (const name of readdirSync(dir)) {
  if (!name.endsWith('.conf')) continue;
  const file = join(dir, name);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      /Content-Security-Policy/i.test(line) ||
      /X-Frame-Options/i.test(line)
    ) {
      console.error(
        `${file}:${i + 1}: nginx must not set CSP or X-Frame-Options (application owns them): ${line.trim()}`,
      );
      failed = true;
    }
  }
}
if (failed) process.exitCode = 1;
else console.log('nginx header ownership check passed.');
