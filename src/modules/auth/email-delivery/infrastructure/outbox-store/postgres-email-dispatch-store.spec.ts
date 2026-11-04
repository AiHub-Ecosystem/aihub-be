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

  describe('a refund for a row this worker no longer holds (#1033)', () => {
    const input = {
      id: ROW_ID,
      owner: 'instance-a',
      previousAttempts: 1,
      previousAttemptAt: PREVIOUS_ATTEMPT_AT,
      retryAt: RETRY_AT,
    };

    function storeOver(
      updateMany: jest.Mock,
      findUnique: jest.Mock,
    ): PostgresEmailDispatchStore {
      return new PostgresEmailDispatchStore({
        emailDeliveryRequest: { updateMany, findUnique },
      } as unknown as ConstructorParameters<
        typeof PostgresEmailDispatchStore
      >[0]);
    }

    it.each([
      [
        'completed by another worker',
        {
          status: 'provider_accepted',
          attempts: 2,
          lastAttemptAt: RETRY_AT,
          leaseExpiresAt: null,
          leaseOwner: null,
        },
      ],
      [
        'held by another worker',
        {
          status: 'queued',
          attempts: 2,
          lastAttemptAt: RETRY_AT,
          leaseExpiresAt: RETRY_AT,
          leaseOwner: 'instance-b',
        },
      ],
      ['gone', null],
    ])(
      'settles without changing a row %s, so the pending refund can be dropped',
      async (_case, row) => {
        const updateMany = jest.fn().mockResolvedValue({ count: 0 });
        const findUnique = jest.fn().mockResolvedValue(row);

        await expect(
          storeOver(updateMany, findUnique).releaseUnspentAttempt(input),
        ).resolves.toBeUndefined();
        expect(updateMany).toHaveBeenCalledTimes(1);
      },
    );

    it('still fails when the refund could not be written to a row this worker holds', async () => {
      const updateMany = jest
        .fn()
        .mockRejectedValue(new Error('connection lost before commit'));
      const findUnique = jest.fn().mockResolvedValue({
        status: 'queued',
        attempts: 2,
        lastAttemptAt: RETRY_AT,
        leaseExpiresAt: RETRY_AT,
        leaseOwner: 'instance-a',
      });

      await expect(
        storeOver(updateMany, findUnique).releaseUnspentAttempt(input),
      ).rejects.toThrow('connection lost before commit');
    });

    it('still fails when the row cannot be read to tell', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const findUnique = jest
        .fn()
        .mockRejectedValue(new Error('database read failed'));

      await expect(
        storeOver(updateMany, findUnique).releaseUnspentAttempt(input),
      ).rejects.toThrow('database read failed');
    });
  });
});
