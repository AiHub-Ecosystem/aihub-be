/**
 * The email or username a registration or a resend asked for is already taken.
 * Carries no detail about the stored identity, so the public envelope stays
 * generic (ADR-0022).
 */
export class AuthIdentityConflictError extends Error {
  constructor() {
    super('local auth identity is unavailable');
    this.name = 'AuthIdentityConflictError';
  }
}
