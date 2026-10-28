import {
  incompatibleJwksHoldReport,
  requirePreviousJwksFormatCompatibility,
} from './n-minus-one-jwks-key-format-probe';

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

  it('records a machine-readable hold with both image revisions for the incompatible fixture', () => {
    const prefix = 'N_MINUS_ONE_COMPATIBILITY_FIXTURE ';
    const report = incompatibleJwksHoldReport(revisions);

    expect(report.startsWith(prefix)).toBe(true);
    expect(JSON.parse(report.slice(prefix.length))).toEqual({
      fixture: 'incompatible_jwks_key_format',
      fixtureResult: 'passed',
      releaseDecision: 'hold',
      previousSha: revisions.previousSha,
      candidateSha: revisions.candidateSha,
      expectedGateResult: 'failed',
      requiredAction: 'fail_release_gate_before_publish',
    });
  });
});
