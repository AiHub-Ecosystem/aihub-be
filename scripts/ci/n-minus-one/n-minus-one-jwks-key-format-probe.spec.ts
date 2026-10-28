import { requirePreviousJwksFormatCompatibility } from './n-minus-one-jwks-key-format-probe';

describe('requirePreviousJwksFormatCompatibility', () => {
  const revisions = {
    previousSha: 'a'.repeat(40),
    candidateSha: 'b'.repeat(40),
  };

  it('allows a compatible previous image to proceed', () => {
    expect(() =>
      requirePreviousJwksFormatCompatibility({
        ...revisions,
        previousCanReadCandidateEntry: true,
      }),
    ).not.toThrow();
  });

  it('holds a release when the previous image cannot read the candidate format', () => {
    expect(() =>
      requirePreviousJwksFormatCompatibility({
        ...revisions,
        previousCanReadCandidateEntry: false,
      }),
    ).toThrow(
      `RELEASE HOLD: N-1 ${revisions.previousSha} cannot read the candidate JWKS cache format from N ${revisions.candidateSha}`,
    );
  });
});
