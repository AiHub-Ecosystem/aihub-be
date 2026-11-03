import {
  type VerificationAccountFacts,
  type VerificationDecision,
  type VerificationTokenFacts,
  decideVerification,
} from './verification-decision';

type DecisionCase = readonly [
  VerificationAccountFacts['status'],
  VerificationTokenFacts['state'],
  boolean,
  boolean,
  VerificationDecision,
];

const decisionCases: readonly DecisionCase[] = [
  ['pending_verification', 'open', false, false, { kind: 'verify' }],
  [
    'pending_verification',
    'open',
    false,
    true,
    { kind: 'sign_in', activateAccount: true },
  ],
  ['pending_verification', 'open', true, false, { kind: 'proof_check' }],
  ['pending_verification', 'open', true, true, { kind: 'proof_check' }],
  ['pending_verification', 'verified', false, false, { kind: 'invalid' }],
  ['pending_verification', 'verified', false, true, { kind: 'invalid' }],
  ['pending_verification', 'verified', true, false, { kind: 'invalid' }],
  ['pending_verification', 'verified', true, true, { kind: 'invalid' }],
  ['pending_verification', 'spent', false, false, { kind: 'invalid' }],
  ['pending_verification', 'spent', false, true, { kind: 'invalid' }],
  ['pending_verification', 'spent', true, false, { kind: 'invalid' }],
  ['pending_verification', 'spent', true, true, { kind: 'invalid' }],
  ['active', 'open', false, false, { kind: 'invalid' }],
  ['active', 'open', false, true, { kind: 'invalid' }],
  ['active', 'open', true, false, { kind: 'invalid' }],
  ['active', 'open', true, true, { kind: 'invalid' }],
  ['active', 'verified', false, false, { kind: 'verified' }],
  [
    'active',
    'verified',
    false,
    true,
    { kind: 'sign_in', activateAccount: false },
  ],
  ['active', 'verified', true, false, { kind: 'verified' }],
  [
    'active',
    'verified',
    true,
    true,
    { kind: 'sign_in', activateAccount: false },
  ],
  ['active', 'spent', false, false, { kind: 'invalid' }],
  ['active', 'spent', false, true, { kind: 'invalid' }],
  ['active', 'spent', true, false, { kind: 'invalid' }],
  ['active', 'spent', true, true, { kind: 'invalid' }],
];

type ProofCase = readonly [boolean | undefined, boolean, VerificationDecision];

const proofCases: readonly ProofCase[] = [
  [undefined, false, { kind: 'proof_check' }],
  [undefined, true, { kind: 'proof_check' }],
  [false, false, { kind: 'proof_required' }],
  [false, true, { kind: 'proof_required' }],
  [true, false, { kind: 'verify' }],
  [true, true, { kind: 'sign_in', activateAccount: true }],
];

type ClaimedCase = readonly [
  VerificationAccountFacts['status'],
  VerificationTokenFacts['state'],
  VerificationDecision,
];

const claimedCases: readonly ClaimedCase[] = [
  ['pending_verification', 'open', { kind: 'verify' }],
  ['active', 'verified', { kind: 'verified' }],
];

describe('decideVerification', () => {
  it.each(decisionCases)(
    '%s account, %s token, requiresProof=%s, browserBindingMatches=%s',
    (status, state, requiresProof, browserBindingMatches, expected) => {
      expect(
        decideVerification(
          { status },
          {
            state,
            requiresProof,
            proofVerified: undefined,
            browserBindingMatches,
            signInClaimed: false,
          },
        ),
      ).toEqual(expected);
    },
  );

  it.each(proofCases)(
    'handles proofVerified=%s with browserBindingMatches=%s',
    (proofVerified, browserBindingMatches, expected) => {
      expect(
        decideVerification(
          { status: 'pending_verification' },
          {
            state: 'open',
            requiresProof: true,
            proofVerified,
            browserBindingMatches,
            signInClaimed: false,
          },
        ),
      ).toEqual(expected);
    },
  );

  it.each(claimedCases)(
    'does not sign in twice for %s account with %s token',
    (status, state, expected) => {
      expect(
        decideVerification(
          { status },
          {
            state,
            requiresProof: false,
            proofVerified: undefined,
            browserBindingMatches: true,
            signInClaimed: true,
          },
        ),
      ).toEqual(expected);
    },
  );
});
