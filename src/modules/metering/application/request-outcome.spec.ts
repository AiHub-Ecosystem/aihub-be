import { requestOutcome } from './request-outcome';

describe('requestOutcome', () => {
  it.each([
    [200, undefined, 'success'],
    [502, 'AI_SERVICE_ERROR', 'downstream_error'],
    [502, 'AI_SERVICE_CONTRACT_VIOLATION', 'downstream_error'],
    // Audio the provider cannot read is the caller's fault (#248): a client
    // error, so it is not billed and does not count against the AI Service.
    [422, 'AUDIO_UNREADABLE', 'client_error'],
    [400, 'INVALID_REQUEST', 'client_error'],
    [500, 'INTERNAL_ERROR', 'internal_error'],
  ] as const)('%i %s is %s', (status, code, outcome) => {
    expect(requestOutcome(status, code)).toBe(outcome);
  });
});
