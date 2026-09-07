import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('idempotency records migration', () => {
  it('creates durable, bounded records with the race-safe state columns', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../database/migrations/0004_idempotency_records.sql',
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
});
