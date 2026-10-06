import type { Pool } from 'pg';

import { createTestPool } from './database';

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe('foreign key indexes', () => {
  // PostgreSQL does not index the referencing column of a foreign key. Without
  // one, deleting or updating a referenced row scans the whole child table, and
  // so does any lookup by that column. A real engine settles this: the answer is
  // in the catalog, not in the migration text.
  it('gives every foreign key an index that starts with its referencing column', async () => {
    const { rows } = await pool.query<{ child: string; column: string }>(`
      SELECT child.relname AS child, attribute.attname AS "column"
      FROM pg_constraint foreign_key
      JOIN pg_class child ON child.oid = foreign_key.conrelid
      JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
      JOIN pg_attribute attribute
        ON attribute.attrelid = child.oid
       AND attribute.attnum = foreign_key.conkey[1]
      WHERE foreign_key.contype = 'f'
        AND namespace.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1
          FROM pg_index index
          WHERE index.indrelid = child.oid
            AND index.indkey[0] = foreign_key.conkey[1]
        )
      ORDER BY child.relname, attribute.attname
    `);

    expect(rows).toEqual([]);
  });
});
