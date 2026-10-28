import { classifyZeroWidthOrganizationWrite } from './n-minus-one-durable-probes';
import { assertNMinusOneGatePasses } from './n-minus-one-runtime';

describe('classifyZeroWidthOrganizationWrite', () => {
  it('passes only when N-1 rejects at the request boundary', () => {
    expect(classifyZeroWidthOrganizationWrite(400, false)).toMatchObject({
      kind: 'pass',
    });
  });

  it('holds when HTTP 500 is independently associated with the named constraint', () => {
    const outcome = classifyZeroWidthOrganizationWrite(500, true);

    expect(outcome.kind).toBe('release_hold');
    expect(outcome.message).toContain('cannot attribute the response');
    expect(() =>
      assertNMinusOneGatePasses([`RELEASE HOLD: ${outcome.message}`]),
    ).toThrow('N-1 release compatibility failed (1 finding(s))');
  });

  it('holds an unrelated HTTP 500', () => {
    const outcome = classifyZeroWidthOrganizationWrite(500, false);

    expect(outcome.kind).toBe('release_hold');
    expect(outcome.message).toContain('did not confirm');
  });

  it('fails if N-1 writes the rejected name or returns another unexpected status', () => {
    expect(classifyZeroWidthOrganizationWrite(201, false)).toMatchObject({
      kind: 'fail',
    });
    expect(classifyZeroWidthOrganizationWrite(503, false)).toMatchObject({
      kind: 'fail',
    });
  });
});
