export type VerificationAccountStatus = 'pending_verification' | 'active';

export type VerificationTokenState = 'open' | 'verified' | 'spent';

export interface VerificationAccountFacts {
  readonly status: VerificationAccountStatus;
}

export interface VerificationTokenFacts {
  readonly state: VerificationTokenState;
  readonly requiresProof: boolean;
  readonly proofVerified: boolean | undefined;
  readonly browserBindingMatches: boolean;
  readonly signInClaimed: boolean;
}

export type VerificationDecision =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'proof_check' }
  | { readonly kind: 'proof_required' }
  | { readonly kind: 'verify' }
  | { readonly kind: 'verified' }
  | { readonly kind: 'sign_in'; readonly activateAccount: boolean };

export function decideVerification(
  account: VerificationAccountFacts,
  token: VerificationTokenFacts,
): VerificationDecision {
  if (account.status === 'pending_verification' && token.state === 'open') {
    if (token.requiresProof && token.proofVerified === undefined) {
      return { kind: 'proof_check' };
    }
    if (token.requiresProof && token.proofVerified === false) {
      return { kind: 'proof_required' };
    }
    if (token.browserBindingMatches && !token.signInClaimed) {
      return { kind: 'sign_in', activateAccount: true };
    }
    return { kind: 'verify' };
  }

  if (account.status === 'active' && token.state === 'verified') {
    if (token.browserBindingMatches && !token.signInClaimed) {
      return { kind: 'sign_in', activateAccount: false };
    }
    return { kind: 'verified' };
  }

  return { kind: 'invalid' };
}
