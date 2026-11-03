import { identityStoreError } from '@/modules/identity/shared/infrastructure/identity-row';

/** The one refusal every invitation repository gives a malformed command. */
export function invalidInvitationInput(): ReturnType<
  typeof identityStoreError
> {
  return identityStoreError(
    'Identity organization invitation input is invalid',
  );
}
