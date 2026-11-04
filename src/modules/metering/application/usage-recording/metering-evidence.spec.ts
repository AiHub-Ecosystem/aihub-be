import {
  type MeteringEvidence,
  attributionFromEvidence,
} from './metering-evidence';

const base: MeteringEvidence = {
  operation: 'writing.task1.grade',
  organizationId: 'org-1',
  apiKeyId: 'key-1',
  environment: 'production',
  settled: false,
};

describe('attributionFromEvidence', () => {
  it('copies the identity of the request and nothing else', () => {
    expect(
      attributionFromEvidence({
        ...base,
        actorId: 'actor-1',
        quotaTracked: true,
        modelCalled: true,
        totalMs: 5,
      }),
    ).toEqual({
      operation: 'writing.task1.grade',
      organizationId: 'org-1',
      apiKeyId: 'key-1',
      environment: 'production',
      actorId: 'actor-1',
      quotaTracked: true,
    });
  });

  it('leaves out an actor and a quota flag the evidence never gathered', () => {
    expect(Object.keys(attributionFromEvidence(base)).sort()).toEqual([
      'apiKeyId',
      'environment',
      'operation',
      'organizationId',
    ]);
  });
});
