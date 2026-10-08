/**
 * Expand-only migration contract check — library (CommonJS) seam for tests.
 * CLI is scripts/checks/check-migrations.mjs which delegates here.
 */

const ALTERNATIVES = {
  'drop-column':
    'use expand/contract: ADD new column nullable, backfill, switch reads, drop in contract deployment days later (spec)',
  'rename-column':
    'use expand/contract: ADD new column, backfill, switch writes/reads, drop old in contract deployment',
  'add-not-null-without-default':
    'use expand/contract: ADD column nullable or with DEFAULT, backfill, then add NOT NULL in later deployment',
};

function hasHatch(sql, kind) {
  const lower = sql.toLowerCase();
  if (kind === 'drop-column') return lower.includes('allow-drop-column');
  if (kind === 'rename-column') return lower.includes('allow-rename-column');
  if (kind === 'add-not-null-without-default')
    return lower.includes('allow-add-not-null');
  return false;
}

function checkSql(sql, filename = 'unknown.sql') {
  const violations = [];
  const hatchDrop = hasHatch(sql, 'drop-column');
  const hatchRename = hasHatch(sql, 'rename-column');
  const hatchAddNotNull = hasHatch(sql, 'add-not-null-without-default');

  // split by ; keeping original for line numbers
  let cursor = 0;
  const rawStatements = sql.split(';');
  for (const raw of rawStatements) {
    const statement = raw.trim();
    if (statement.length === 0) continue;
    // find line number: count \n up to cursor + raw start
    const idx = sql.indexOf(raw, cursor);
    const upTo = idx >= 0 ? sql.slice(0, idx) : sql.slice(0, cursor);
    const line = (upTo.match(/\n/g) || []).length + 1;
    cursor = idx >= 0 ? idx + raw.length + 1 : cursor + raw.length + 1;
    const trimmedStatement = statement.replace(/\s+/g, ' ').slice(0, 120);

    // strip single-line -- comments for pattern matching but keep statement for message
    const withoutLineComments = statement
      .split('\n')
      .map((l) => {
        const c = l.indexOf('--');
        // keep hatch marker line out of statement check? It's a comment, so removing it is fine
        if (c >= 0) return l.slice(0, c);
        return l;
      })
      .join('\n');
    // also strip /* */ block comments
    const clean = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, ' ');

    if (!hatchDrop && /\bDROP\s+COLUMN\b/i.test(clean)) {
      violations.push({
        file: filename,
        line,
        statement: trimmedStatement,
        kind: 'drop-column',
        alternative: ALTERNATIVES['drop-column'],
      });
      continue;
    }
    if (!hatchRename && /\bRENAME\s+COLUMN\b/i.test(clean)) {
      violations.push({
        file: filename,
        line,
        statement: trimmedStatement,
        kind: 'rename-column',
        alternative: ALTERNATIVES['rename-column'],
      });
      continue;
    }
    if (!hatchAddNotNull) {
      const hasAddColumn = /\bADD\s+COLUMN\b/i.test(clean);
      const hasNotNull = /\bNOT\s+NULL\b/i.test(clean);
      const hasDefault = /\bDEFAULT\b/i.test(clean);
      if (hasAddColumn && hasNotNull && !hasDefault) {
        violations.push({
          file: filename,
          line,
          statement: trimmedStatement,
          kind: 'add-not-null-without-default',
          alternative: ALTERNATIVES['add-not-null-without-default'],
        });
      }
    }
  }
  return violations;
}

function formatViolation(v) {
  return `Migration check failed: ${v.file}:${v.line} — ${v.statement} — ${v.kind} — ${v.alternative}`;
}

module.exports = { checkSql, formatViolation };
