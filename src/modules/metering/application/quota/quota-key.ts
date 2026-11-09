/** The Redis key for one Organization's quota counter in one UTC month. */
export function quotaKeyForMonth(
  organizationId: string,
  month: string,
): string {
  return `aihub:v1:quota:${organizationId}:${month}`;
}
