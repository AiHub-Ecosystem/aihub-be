import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('idempotency records migration', () => {
  it('creates durable, bounded records with the race-safe state columns', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../prisma/migrations/0004_idempotency_records/migration.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS idempotency_records',
    );
    expect(migration).toContain(
      'PRIMARY KEY (organization_id, operation, idempotency_key)',
    );
    expect(migration).toContain("state IN ('pending', 'completed', 'failed')");
    expect(migration).toContain('octet_length(request_fingerprint) = 32');
    expect(migration).toContain('octet_length(idempotency_key) <= 255');
    expect(migration).toContain('idempotency_records_expires_idx');
  });

  it('adds the management scope without changing the existing migration history', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../prisma/migrations/0013_idempotency_management_scope/migration.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS actor_scope text NOT NULL DEFAULT',
    );
    expect(migration).toContain(
      'PRIMARY KEY (organization_id, operation, actor_scope, idempotency_key)',
    );
  });
});
