import { OutstandingQuotaReservationRegistry } from './outstanding-quota-reservations';

const owner = {
  organizationId: 'org_acme',
  environment: 'production' as const,
};

describe('OutstandingQuotaReservationRegistry', () => {
  it('counts nothing without a registered source', async () => {
    await expect(
      new OutstandingQuotaReservationRegistry().count(owner),
    ).resolves.toBe(0);
  });

  it('sums every registered source for the Organization and Environment', async () => {
    const registry = new OutstandingQuotaReservationRegistry();
    const first = { outstanding: jest.fn(async () => 2) };
    const second = { outstanding: jest.fn(async () => 3) };
    registry.register(first);
    registry.register(second);

    await expect(registry.count(owner)).resolves.toBe(5);
    expect(first.outstanding).toHaveBeenCalledWith(owner);
    expect(second.outstanding).toHaveBeenCalledWith(owner);
  });

  it('rejects when a source cannot answer, so callers can mark the quota unverified', async () => {
    const registry = new OutstandingQuotaReservationRegistry();
    registry.register({
      outstanding: async () => {
        throw new Error('store unavailable');
      },
    });

    await expect(registry.count(owner)).rejects.toThrow('store unavailable');
  });
});
