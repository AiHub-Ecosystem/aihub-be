#!/usr/bin/env node
/**
 * Schema/migration drift contract (ADR-0088, #40).
 *
 * `prisma/schema.prisma` describes the control-plane schema, and
 * `database/migrations/` builds it. They are two copies of one thing, so this
 * file decides what "they disagree" means, and `check-prisma-drift.mjs` runs
 * the comparison against a database built from the migrations.
 *
 * The verdict is a pure function of the CLI's diff output so a spec can pin
 * both directions without a PostgreSQL instance.
 *
 * `prisma migrate diff --script` prints a lone comment when the two sides
 * already agree. Anything else is a statement that would change the database.
 */
const EMPTY_DIFF = '-- This is an empty migration.';

/**
 * Statements the engine prints as bookkeeping rather than as schema drift.
 * This list is deliberately empty: every entry added here is a difference the
 * drift check would stop catching, so a new one needs its reason recorded
 * beside it.
 */
const IGNORED_PREFIXES = [];

/**
 * The statements a drifted pair produces, or `[]` when the pair agrees.
 */
function driftStatements(output) {
  if (output.includes(EMPTY_DIFF)) {
    return [];
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--'))
    .filter(
      (line) => !IGNORED_PREFIXES.some((prefix) => line.startsWith(prefix)),
    );
}

module.exports = { driftStatements };
