import type { Pool } from 'pg';

import { isDisplayText } from '@/modules/identity/domain/display-text';

import { createTestPool, resetIdentityTables } from '../shared/database';

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
});

/**
 * The write the operator `org:create` command makes: a plain insert of a name
 * the caller chose. The database refuses what the domain refuses, so no write
 * path has to remember the rule.
 */
function insertName(name: string, id = 'org_probe'): Promise<unknown> {
  return pool.query(
    "INSERT INTO organizations (id, name, status) VALUES ($1, $2, 'active')",
    [id, name],
  );
}

describe('the Organization name check constraint', () => {
  it.each([
    ['a line break', 'Acme\nLtd'],
    ['a bidirectional override', 'Acme \u202Edtl'],
    ['a zero width space', 'Acme\u200BLtd'],
    ['a soft hyphen', 'Acme\u00ADLtd'],
    ['a no-break zero width space', 'Acme﻿Ltd'],
    ['a word joiner', 'Acme⁠Ltd'],
    ['an invisible separator', 'Acme⁤Ltd'],
    ['an Arabic letter mark', 'Acme؜Ltd'],
    ['a next line control', 'AcmeLtd'],
    ['an untrimmed name', ' Acme'],
    ['a leading no-break space', '\u00A0Acme'],
    ['a trailing ideographic space', 'Acme\u3000'],
    ['an over-long name', 'a'.repeat(101)],
    ['an empty name', ''],
  ])('refuses a name with %s', async (_label, name) => {
    await expect(insertName(name)).rejects.toMatchObject({ code: '23514' });
    const stored = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM organizations',
    );
    expect(stored.rows[0]?.count).toBe(0);
  });

  it('accepts a visible name and an emoji sequence', async () => {
    await expect(insertName('Acme 👨‍👩‍👧')).resolves.toBeDefined();
    await expect(
      pool.query('SELECT name FROM organizations'),
    ).resolves.toMatchObject({ rows: [{ name: 'Acme 👨‍👩‍👧' }] });
  });

  it('refuses exactly the characters the domain display-text rule refuses', async () => {
    // Every BMP character up to U+2100, plus U+FEFF, embedded in a name. The
    // domain rule and the constraint must agree on each one.
    const disagreements: string[] = [];
    const codePoints = [
      ...Array.from({ length: 0x2100 }, (_, index) => index),
      0xfeff,
    ];
    for (const codePoint of codePoints) {
      const name = `a${String.fromCodePoint(codePoint)}b`;
      const stored = await insertName(name, `org_${codePoint}`).then(
        () => true,
        () => false,
      );
      if (stored !== isDisplayText(name)) {
        disagreements.push(`U+${codePoint.toString(16).toUpperCase()}`);
      }
    }

    expect(disagreements).toEqual([]);
  }, 60_000);
});
