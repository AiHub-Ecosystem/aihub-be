import { PostgresEmailDispatchStore } from './postgres-email-dispatch-store';

const ROW_ID = 'edr_01J00000000000000000000000';
const PREVIOUS_ATTEMPT_AT = new Date('2026-10-05T12:00:00.000Z');
const RETRY_AT = new Date('2026-10-05T12:01:00.000Z');

describe('PostgresEmailDispatchStore', () => {
  it('releases the reserved attempt and defers without a follow-up read', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findUnique = jest.fn();
    const store = new PostgresEmailDispatchStore({
      emailDeliveryRequest: { updateMany, findUnique },
    } as unknown as ConstructorParameters<
      typeof PostgresEmailDispatchStore
    >[0]);

    await store.releaseUnspentAttempt({
      id: ROW_ID,
      owner: 'instance-a',
      previousAttempts: 1,
      previousAttemptAt: PREVIOUS_ATTEMPT_AT,
      retryAt: RETRY_AT,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: ROW_ID,
        status: 'queued',
        leaseOwner: 'instance-a',
        attempts: { gt: 0 },
      },
      data: {
        attempts: { decrement: 1 },
        lastAttemptAt: PREVIOUS_ATTEMPT_AT,
        leaseOwner: null,
        leaseExpiresAt: RETRY_AT,
      },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('reconciles a committed release after the first recovery read fails', async () => {
    const releasedRow = {
      status: 'queued',
      attempts: 1,
      lastAttemptAt: PREVIOUS_ATTEMPT_AT,
      leaseExpiresAt: RETRY_AT,
    };
    let updates = 0;
    const updateMany = jest.fn(async () => {
      updates += 1;
      if (updates === 1) throw new Error('connection lost after commit');
      return { count: 0 };
    });
    let reads = 0;
    const findUnique = jest.fn(async () => {
      reads += 1;
      if (reads === 1) throw new Error('database read failed');
      return releasedRow;
    });
    const store = new PostgresEmailDispatchStore({
      emailDeliveryRequest: { updateMany, findUnique },
    } as unknown as ConstructorParameters<
      typeof PostgresEmailDispatchStore
    >[0]);
    const input = {
      id: ROW_ID,
      owner: 'instance-a',
      previousAttempts: 1,
      previousAttemptAt: PREVIOUS_ATTEMPT_AT,
      retryAt: RETRY_AT,
    };

    await expect(store.releaseUnspentAttempt(input)).rejects.toThrow(
      'database read failed',
    );
    await expect(store.releaseUnspentAttempt(input)).resolves.toBeUndefined();

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
