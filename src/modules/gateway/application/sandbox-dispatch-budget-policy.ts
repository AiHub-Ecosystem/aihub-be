export const SANDBOX_ENVIRONMENT_MONTHLY_LIMIT = 500;

export function canReserveSandboxDispatch(input: {
  readonly organizationCount: number;
  readonly organizationLimit: number;
  readonly environmentCount: number;
}): boolean {
  return (
    input.organizationCount < input.organizationLimit &&
    input.environmentCount < SANDBOX_ENVIRONMENT_MONTHLY_LIMIT
  );
}
