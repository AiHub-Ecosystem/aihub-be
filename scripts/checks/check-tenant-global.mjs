#!/usr/bin/env node
import { join } from 'node:path';
import process from 'node:process';

import { defineFileVisitorCheck } from './support/check-runner.mjs';

/**
 * Rejects recovering Organization identity from a module-level (repository-global)
 * variable. Organization identity must arrive through RequestContext or explicit
 * application inputs (AGENTS.md, #763).
 *
 * Scans src/modules for top-level `let`/`var` declarations whose name contains
 * an organization/tenant marker. `const` module-level values are allowed (they
 * cannot be reassigned, so they cannot carry per-request tenant state).
 */

// broader: identifier contains org/tenant
const TENANT_IDENT = /(organi[sz]ation|tenant)/i;

// Allowlist: file path (relative, posix) -> reason
/** @type {Set<string>} */
const allowlist = new Set();

const run = defineFileVisitorCheck({
  directory: () => join(process.cwd(), 'src', 'modules'),
  successMessage: 'No module-level tenant state found.',
  visitFile: ({ relativePath, source }) => {
    if (allowlist.has(relativePath)) return [];
    /** @type {Array<{line: number, detail: string}>} */
    const violations = [];
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      // top-level let/var declaration (not indented inside a function/class)
      const m = /^\s*(export\s+)?(let|var)\s+([A-Za-z_$][\w$]*)\b/.exec(line);
      if (!m) continue;
      const name = m[3];
      if (!TENANT_IDENT.test(name)) continue;
      violations.push({
        line: index + 1,
        detail: `module-level mutable tenant state \`${name}\` is forbidden; pass Organization identity through RequestContext or application inputs.`,
      });
    }
    return violations;
  },
});

run();
