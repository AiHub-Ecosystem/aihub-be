/**
 * The single definition of what a sandbox end-user identifier may be.
 *
 * The value is caller-supplied and travels into the `sub` claim and into
 * request logs, so it is checked at the transport boundary and again in the
 * application service. Both checks read this file: two independently written
 * copies of one rule drift, and a boundary that is stricter than the service
 * behind it leaves unreachable branches that look like coverage.
 *
 * The ceiling sits well under the 256-character limit the verifier enforces on
 * bounded claims, and the character set excludes anything that could break a
 * log line.
 */
export const SANDBOX_USER_ID_MAX_LENGTH = 128;

export const SANDBOX_USER_ID_PATTERN = '^[A-Za-z0-9_-]+$';

const COMPILED_PATTERN = new RegExp(SANDBOX_USER_ID_PATTERN);

export function isSandboxUserId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= SANDBOX_USER_ID_MAX_LENGTH &&
    COMPILED_PATTERN.test(value)
  );
}
