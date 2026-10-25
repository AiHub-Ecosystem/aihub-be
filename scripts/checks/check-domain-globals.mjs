#!/usr/bin/env node
import { join } from 'node:path';
import process from 'node:process';

import { defineFileVisitorCheck } from './support/check-runner.mjs';

const patterns = [
  { name: 'Date.now()', re: /\bDate\.now\s*\(\s*\)/ },
  { name: 'new Date() without argument', re: /\bnew\s+Date\s*\(\s*\)/ },
  { name: 'Math.random()', re: /\bMath\.random\s*\(\s*\)/ },
  { name: 'fetch', re: /\bfetch\s*\(/ },
  { name: 'crypto.randomUUID()', re: /\bcrypto\.randomUUID\s*\(\s*\)/ },
  { name: 'process.*', re: /\bprocess\.\w+/ },
];

const run = defineFileVisitorCheck({
  directory: () => join(process.cwd(), 'src'),
  successMessage: 'Domain bare-globals check passed.',
  visitFile: ({ relativePath, source }) => {
    if (!relativePath.includes('/domain/')) return [];
    const violations = [];
    for (const { name, re } of patterns) {
      if (re.test(source)) {
        violations.push({
          detail: `bare global \`${name}\` is forbidden in domain code (ADR-0090 / #807).`,
        });
      }
    }
    return violations;
  },
});

run();
