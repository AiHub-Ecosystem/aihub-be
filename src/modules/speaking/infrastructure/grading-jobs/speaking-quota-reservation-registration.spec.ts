import { SpeakingQuotaReservationRegistration } from './speaking-quota-reservation-registration';

describe('SpeakingQuotaReservationRegistration', () => {
  it('registers itself with Gateway on module init and reports active job reservations', async () => {
    const register = jest.fn();
    const countInFlight = jest.fn(async () => 3);
    const registration = new SpeakingQuotaReservationRegistration(
      { register },
      { countInFlight },
    );

    registration.onModuleInit();

    expect(register).toHaveBeenCalledWith(registration);
    await expect(
      registration.outstanding({
        organizationId: 'org_acme',
        environment: 'production',
      }),
    ).resolves.toBe(3);
    expect(countInFlight).toHaveBeenCalledWith({
      organizationId: 'org_acme',
      environment: 'production',
    });
  });
});
