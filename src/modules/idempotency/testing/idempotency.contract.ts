import { ORGANIZATION_CREATE_OPERATION } from '@/modules/idempotency/application/idempotency-operation';
import type { IdempotencyOperation } from '@/modules/idempotency/application/idempotency-operation';
import type { IdempotencyRepositoryPort } from '@/modules/idempotency/application/idempotency-repository.port';

export function idempotencyRepositoryContract(
  createRepo: () => IdempotencyRepositoryPort,
  reset: () => Promise<void>,
): void {
  let repo: IdempotencyRepositoryPort;

  beforeEach(async () => {
    await reset();
    repo = createRepo();
  });

  const baseInput = (
    overrides: Partial<{
      organizationId: string | null;
      operation: IdempotencyOperation;
      idempotencyKey: string;
      fingerprintHex: string;
      requestId: string;
      expiresAt: Date;
    }> = {},
  ) => ({
    organizationId: 'org_1',
    operation: ORGANIZATION_CREATE_OPERATION,
    actorScope: '',
    idempotencyKey: 'key-1',
    fingerprintHex: 'a'.repeat(64),
    requestId: 'req_1',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });

  it('claims a new key', async () => {
    const r = await repo.reserve(baseInput());
    expect(r).toEqual({ kind: 'claimed', requestId: 'req_1' });
  });

  it('conflicts with pending on same key', async () => {
    await repo.reserve(baseInput());
    const r = await repo.reserve(baseInput({ requestId: 'req_2' }));
    expect(r).toEqual({ kind: 'conflict', reason: 'pending' });
  });

  it('conflicts on fingerprint mismatch', async () => {
    await repo.reserve(baseInput());
    const r = await repo.reserve(baseInput({ fingerprintHex: 'b'.repeat(64) }));
    expect(r).toEqual({ kind: 'conflict', reason: 'fingerprint' });
  });

  it('replays completed with stored status and body', async () => {
    await repo.reserve(baseInput());
    await repo.complete({
      organizationId: 'org_1',
      operation: ORGANIZATION_CREATE_OPERATION,
      actorScope: '',
      idempotencyKey: 'key-1',
      requestId: 'req_1',
      responseStatus: 201,
      responseBody: { ok: true },
    });
    const r = await repo.reserve(baseInput({ requestId: 'req_2' }));
    expect(r).toEqual({
      kind: 'replay',
      responseStatus: 201,
      responseBody: { ok: true },
    });
  });

  it('reclaims a failed record', async () => {
    await repo.reserve(baseInput());
    await repo.markFailed({
      organizationId: 'org_1',
      operation: ORGANIZATION_CREATE_OPERATION,
      actorScope: '',
      idempotencyKey: 'key-1',
      requestId: 'req_1',
    });
    const r = await repo.reserve(baseInput({ requestId: 'req_2' }));
    expect(r).toEqual({ kind: 'claimed', requestId: 'req_2' });
  });

  it('reclaims an expired record', async () => {
    await repo.reserve(baseInput({ expiresAt: new Date(Date.now() - 1000) }));
    const r = await repo.reserve(baseInput({ requestId: 'req_2' }));
    expect(r).toEqual({ kind: 'claimed', requestId: 'req_2' });
  });

  it('cleanupExpired removes expired records', async () => {
    await repo.reserve(baseInput({ expiresAt: new Date(Date.now() - 1000) }));
    const count = await repo.cleanupExpired();
    expect(count).toBe(1);
  });
}
