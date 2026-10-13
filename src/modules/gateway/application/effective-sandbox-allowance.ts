/** A month override replaces the persisted default; missing policy stays missing. */
export function effectiveSandboxAllowance(
  monthlyOverride: number | null,
  persistedDefault: number | null,
): number | null {
  return monthlyOverride ?? persistedDefault;
}
