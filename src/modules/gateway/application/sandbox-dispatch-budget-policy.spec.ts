import {
  SANDBOX_ENVIRONMENT_MONTHLY_LIMIT,
  canReserveSandboxDispatch,
} from './sandbox-dispatch-budget-policy';

describe('Sandbox dispatch budget policy', () => {
  it('admits only while both locked reservation counts are below their limits', () => {
    expect(
      canReserveSandboxDispatch({
        organizationCount: 4,
        organizationLimit: 5,
        environmentCount: SANDBOX_ENVIRONMENT_MONTHLY_LIMIT - 1,
      }),
    ).toBe(true);
    expect(
      canReserveSandboxDispatch({
        organizationCount: 5,
        organizationLimit: 5,
        environmentCount: 0,
      }),
    ).toBe(false);
    expect(
      canReserveSandboxDispatch({
        organizationCount: 0,
        organizationLimit: 5,
        environmentCount: SANDBOX_ENVIRONMENT_MONTHLY_LIMIT,
      }),
    ).toBe(false);
  });

  it('does not admit reservations against a zero Organization allowance', () => {
    expect(
      canReserveSandboxDispatch({
        organizationCount: 0,
        organizationLimit: 0,
        environmentCount: 0,
      }),
    ).toBe(false);
  });
});
