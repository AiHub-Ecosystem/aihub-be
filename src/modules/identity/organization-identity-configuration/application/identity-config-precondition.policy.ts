import type { IdentityConfigPrecondition } from './organization-identity-config-repository.port';

/**
 * Whether a write's precondition still describes what is stored (ADR-0132).
 * `currentRevision` is the revision of the configuration row the write holds
 * a lock on, or undefined when no row exists. A write that names no
 * precondition always holds: the last writer wins, as it always has.
 */
export function identityConfigPreconditionHolds(
  precondition: IdentityConfigPrecondition | undefined,
  currentRevision: string | undefined,
): boolean {
  if (precondition === undefined) {
    return true;
  }
  return precondition.kind === 'absent'
    ? currentRevision === undefined
    : currentRevision === precondition.revision;
}
