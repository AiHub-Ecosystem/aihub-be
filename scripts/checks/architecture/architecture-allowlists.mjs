/**
 * Path-based exceptions to the source-text rules in check-architecture.mjs.
 *
 * Every entry names the file and the reason it is exempt. A new repository is
 * checked by default: add an entry here only after reviewing the reason, so a
 * single caller never has to widen a rule. Keeping the registry beside the
 * checker, rather than inside it, makes the exceptions reviewable on their own.
 */

/**
 * Files that may open a transaction directly instead of going through
 * organizationTransaction (Identity: identityTransaction). #785, ADR-0109.
 *
 * @type {ReadonlyMap<string, string>}
 */
export const DIRECT_TRANSACTION_ALLOWED = new Map([
  [
    'src/modules/persistence/infrastructure/organization-transaction.ts',
    'the seam itself',
  ],
  [
    'src/modules/identity/shared/infrastructure/postgres-identity.client.ts',
    'the Identity form of the seam and its unscoped pre-tenant form',
  ],
  [
    'src/modules/auth/shared/infrastructure/auth-prisma.ts',
    'Auth sessions and accounts, not Organization-owned rows',
  ],
  [
    'src/modules/avatar/infrastructure/postgres-avatar.repository.ts',
    'User-scoped avatar rows, no Organization column',
  ],
  [
    'src/modules/metering/infrastructure/billing/postgres-billing-statement.repository.ts',
    'Operator billing snapshot, close and adjustment across Organizations',
  ],
  [
    'src/modules/metering/infrastructure/billing/postgres-public-api-major-usage.repository.ts',
    'fleet-wide collector coverage, no Organization',
  ],
  [
    'src/modules/metering/infrastructure/billing/postgres-usage-retention.repository.ts',
    'fleet-wide usage pruning job',
  ],
  [
    'src/modules/writing/chart-uploads/infrastructure/postgres-writing-chart-revocation-audit.repository.ts',
    'Operator revocation that discovers the Organization from the asset',
  ],
]);

/**
 * Identity repositories that may run a statement on their own client outside
 * the organization transaction seam. #785, ADR-0109.
 *
 * @type {ReadonlyMap<string, string>}
 */
export const UNSCOPED_IDENTITY_CLIENT_ALLOWED = new Map([
  [
    'src/modules/identity/api-keys/infrastructure/postgres-api-key.repository.ts',
    'pre-tenant lookup by key hash (ADR-0109 decision 6, #80)',
  ],
  [
    'src/modules/identity/membership/infrastructure/postgres-organization-membership-read.repository.ts',
    'pre-tenant roster of one User Account across Organizations (ADR-0109 decision 6, #80)',
  ],
  [
    'src/modules/identity/notifications/infrastructure/postgres-api-key-near-expiry-notices.ts',
    'scheduled sweep across Organizations, not request-serving',
  ],
  [
    'src/modules/identity/shared/infrastructure/postgres-operator-redis-failure.repository.ts',
    'Operator Redis failure record, no Organization column',
  ],
]);

/**
 * The only callers allowed to name admitSessionContinuation, which stores a
 * session without the second-factor check. ADR-0054, #784.
 *
 * @type {ReadonlySet<string>}
 */
export const SESSION_CONTINUATION_USERS = new Set([
  'src/modules/auth/shared/infrastructure/auth-mfa-session.guard.ts',
  'src/modules/auth/web-sessions/infrastructure/postgres-refresh-session.repository.ts',
]);

/**
 * Infrastructure casts of application-declared types reviewed under ADR-0090.
 * Each key is "path::TypeName".
 *
 * @type {ReadonlySet<string>}
 */
export const CAST_ALLOWLIST = new Set([]);
