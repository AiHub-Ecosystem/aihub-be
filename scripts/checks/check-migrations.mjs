#!/usr/bin/env node
/**
 * Expand-only migration contract check.
 *
 * Mirrors scripts/checks/check-architecture.mjs: reads database/migrations/*.sql,
 * fails on forbidden expand-only patterns, prints file:line statement + alternative.
 *
 * What it checks (narrow, honest):
 * - DROP COLUMN
 * - RENAME COLUMN
 * - ADD COLUMN ... NOT NULL without DEFAULT
 *
 * What it does NOT catch (green != full proof):
 * - ; inside dollar-quoted $$ or 'string' literals, ALTER TYPE, DROP TABLE/CONSTRAINT,
 *   CREATE INDEX without CONCURRENTLY, views, materialized views.
 * - Statement-level SQL parsing is not a full parser; false sense worse than small set.
 *
 * Escape hatch for genuine contract migrations (separate deployment days later):
 *   -- expand-contract: allow-drop-column — reason: ... — approved: <PR/issue>
 *   -- expand-contract: allow-rename-column — reason: ... — approved: <PR/issue>
 *   -- expand-contract: allow-add-not-null — reason: ... — approved: <PR/issue>
 * Marker must be in file and must match the violated kind, otherwise still fails.
 */

import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { checkSql, formatViolation } = require('./check-migrations.cjs');

const MIGRATIONS_DIR = 'database/migrations';

async function main() {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((n) => n.endsWith('.sql')).sort();
  let violations = [];
  for (const file of files) {
    const content = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    violations.push(...checkSql(content, file));
  }
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(formatViolation(v));
    }
    process.exitCode = 1;
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-migrations.mjs')
) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
