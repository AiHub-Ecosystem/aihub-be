import { checkSql } from './check-migrations.cjs';

describe('checkSql expand-only contract', () => {
  it('passes CREATE TABLE', () => {
    const sql = 'CREATE TABLE foo (id text PRIMARY KEY);';
    expect(checkSql(sql, '0001.sql')).toEqual([]);
  });

  it('passes ADD nullable column', () => {
    const sql = 'ALTER TABLE organizations ADD COLUMN IF NOT EXISTS bar text;';
    expect(checkSql(sql, '0002.sql')).toEqual([]);
  });

  it('passes ADD NOT NULL with DEFAULT', () => {
    const sql =
      "ALTER TABLE idempotency_records ADD COLUMN IF NOT EXISTS actor_scope text NOT NULL DEFAULT '';";
    expect(checkSql(sql, '0013.sql')).toEqual([]);
  });

  it('fails DROP COLUMN and names file, statement, alternative', () => {
    const sql = 'ALTER TABLE foo DROP COLUMN bar;';
    const violations = checkSql(sql, '0002_drop.sql');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.file).toBe('0002_drop.sql');
    expect(violations[0]!.statement).toMatch(/DROP COLUMN/i);
    expect(violations[0]!.kind).toMatch(/drop-column/i);
    expect(violations[0]!.alternative).toMatch(/expand\/contract/i);
    expect(violations[0]!.line).toBeGreaterThan(0);
  });

  it('fails RENAME COLUMN', () => {
    const sql = 'ALTER TABLE foo RENAME COLUMN a TO b;';
    expect(checkSql(sql, '0003_rename.sql')).toHaveLength(1);
  });

  it('fails ADD NOT NULL without DEFAULT', () => {
    const sql = 'ALTER TABLE foo ADD COLUMN bar TEXT NOT NULL;';
    expect(checkSql(sql, '0004_notnull.sql')).toHaveLength(1);
  });

  it('is case-insensitive and handles quoted identifiers', () => {
    const sql = 'alter table "Foo" add column "Bar" text not null;';
    expect(checkSql(sql, '0005.sql')).toHaveLength(1);
  });

  it('allows DROP COLUMN with hatch marker', () => {
    const sql =
      '-- expand-contract: allow-drop-column — reason: backfill done — approved: #123\nALTER TABLE foo DROP COLUMN bar;';
    expect(checkSql(sql, '0006_contract.sql')).toEqual([]);
  });

  it('still fails DROP COLUMN when hatch kind does not match', () => {
    const sql =
      '-- expand-contract: allow-rename-column — reason: ... — approved: #123\nALTER TABLE foo DROP COLUMN bar;';
    expect(checkSql(sql, '0007.sql')).toHaveLength(1);
  });

  it('passes existing 0013 migration (has DEFAULT)', () => {
    const sql =
      "ALTER TABLE idempotency_records\n  ADD COLUMN IF NOT EXISTS actor_scope text NOT NULL DEFAULT '';";
    expect(checkSql(sql, '0013_idempotency_management_scope.sql')).toEqual([]);
  });

  it('passes with DEFAULT in same statement among multiple statements', () => {
    const sql =
      'ALTER TABLE a ADD COLUMN x text NOT NULL DEFAULT 0; ALTER TABLE b DROP COLUMN y;';
    // first statement passes (has DEFAULT), second fails even without hatch
    const v = checkSql(sql, 'multi.sql');
    expect(v).toHaveLength(1);
    expect(v[0]!.statement).toMatch(/DROP COLUMN/i);
  });
});
