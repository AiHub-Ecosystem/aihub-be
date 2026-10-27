export function hasRequiredOrganizationApiKeyEntitlements(
  organizationEntitlements: readonly string[],
  requiredEntitlements: readonly string[],
): boolean {
  return requiredEntitlements.every((entitlement) =>
    organizationEntitlements.includes(entitlement),
  );
}

export function reachedOrganizationApiKeyLimit(
  activeKeyCount: number,
  activeKeyLimit: number,
): boolean {
  return activeKeyCount >= activeKeyLimit;
}
