const MAX_ORGANIZATION_NAME_LENGTH = 100;

/**
 * The one rule an Organization name meets wherever an owner sets it, at
 * creation (ADR-0041) and at rename (ADR-0043): trimmed, then 1–100
 * characters, not unique. Returns the stored form, or undefined when refused.
 */
export function organizationName(requested: string): string | undefined {
  const name = requested.trim();
  return name.length === 0 || name.length > MAX_ORGANIZATION_NAME_LENGTH
    ? undefined
    : name;
}
