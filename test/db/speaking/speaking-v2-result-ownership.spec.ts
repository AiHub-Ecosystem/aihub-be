import { ulid } from 'ulid';

import { createFixturePrismaClient } from '@/modules/persistence/persistence.module';
import type { SpeakingV2ResultOwner } from '@/modules/speaking/application/speaking-v2-result-ownership.port';
import { PostgresSpeakingV2ResultOwnershipRepository } from '@/modules/speaking/infrastructure/postgres-speaking-v2-result-ownership.repository';
import { testDatabaseUrl } from '../shared/database';

describe('Speaking v2 result ownership in PostgreSQL', () => {
  const client = createFixturePrismaClient(testDatabaseUrl());
  const repository = new PostgresSpeakingV2ResultOwnershipRepository(client);
  const id = `shared-${ulid()}`;
  const otherOrganizationId = `org_${ulid()}`;
  const base: SpeakingV2ResultOwner = {
    organizationId: `org_${ulid()}`,
    environment: 'production',
    endUserId: 'Learner-A',
  };

  beforeAll(async () => {
    for (const organizationId of [base.organizationId, otherOrganizationId]) {
      await client.$executeRawUnsafe(
        `INSERT INTO organizations (id, name, status) VALUES ($1, $2, 'active')`,
        organizationId,
        `Speaking ownership ${organizationId}`,
      );
    }
  });

  afterAll(async () => client.close());

  it('refuses a record for an Organization that does not exist', async () => {
    await expect(
      repository.record(
        { ...base, organizationId: `org_${ulid()}` },
        'response',
        id,
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
  });

  it('isolates by Organization, End-User ID and environment, and ignores duplicate inserts', async () => {
    await repository.record(base, 'response', id);
    await repository.record(base, 'response', id);
    await expect(
      repository.findOwnedIds(base, 'response', [id]),
    ).resolves.toEqual([id]);
    await expect(
      repository.findOwnedIds(
        { ...base, organizationId: otherOrganizationId },
        'response',
        [id],
      ),
    ).resolves.toEqual([]);
    await expect(
      repository.findOwnedIds({ ...base, endUserId: 'learner-a' }, 'response', [
        id,
      ]),
    ).resolves.toEqual([]);
    await expect(
      repository.findOwnedIds({ ...base, environment: 'sandbox' }, 'response', [
        id,
      ]),
    ).resolves.toEqual([]);

    await repository.record(
      { ...base, organizationId: otherOrganizationId },
      'response',
      id,
    );
    await repository.record(
      { ...base, endUserId: 'learner-a' },
      'response',
      id,
    );
    await repository.record(
      { ...base, environment: 'sandbox' },
      'response',
      id,
    );
    await expect(
      repository.findOwnedIds({ ...base, endUserId: 'learner-a' }, 'response', [
        id,
      ]),
    ).resolves.toEqual([id]);
    await expect(
      repository.findOwnedIds({ ...base, environment: 'sandbox' }, 'response', [
        id,
      ]),
    ).resolves.toEqual([id]);
    const rows = await client.$queryRawUnsafe<readonly { count: bigint }[]>(
      `SELECT count(*) AS count FROM speaking_v2_result_ownership
       WHERE organization_id = $1 AND environment = $2 AND end_user_id = $3 AND kind = $4 AND id = $5`,
      base.organizationId,
      base.environment,
      base.endUserId,
      'response',
      id,
    );
    expect(rows[0]?.count).toBe(1n);
  });
});
