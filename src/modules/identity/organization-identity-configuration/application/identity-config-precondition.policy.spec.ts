import { identityConfigPreconditionHolds } from './identity-config-precondition.policy';

describe('identityConfigPreconditionHolds (ADR-0132)', () => {
  it('holds for a write that names no precondition, whatever is stored', () => {
    expect(identityConfigPreconditionHolds(undefined, undefined)).toBe(true);
    expect(identityConfigPreconditionHolds(undefined, '7')).toBe(true);
  });

  it('holds for a revision only when it is the stored one', () => {
    const precondition = { kind: 'revision', revision: '7' } as const;

    expect(identityConfigPreconditionHolds(precondition, '7')).toBe(true);
    expect(identityConfigPreconditionHolds(precondition, '8')).toBe(false);
    expect(identityConfigPreconditionHolds(precondition, '6')).toBe(false);
  });

  it('does not hold for a revision when nothing is stored', () => {
    expect(
      identityConfigPreconditionHolds(
        { kind: 'revision', revision: '1' },
        undefined,
      ),
    ).toBe(false);
  });

  it('holds for a create-only write only when nothing is stored', () => {
    const precondition = { kind: 'absent' } as const;

    expect(identityConfigPreconditionHolds(precondition, undefined)).toBe(true);
    expect(identityConfigPreconditionHolds(precondition, '1')).toBe(false);
  });

  it('compares digit strings exactly, not as numbers', () => {
    const precondition = {
      kind: 'revision',
      revision: '9007199254740993',
    } as const;

    expect(
      identityConfigPreconditionHolds(precondition, '9007199254740993'),
    ).toBe(true);
    expect(
      identityConfigPreconditionHolds(precondition, '9007199254740992'),
    ).toBe(false);
  });
});
