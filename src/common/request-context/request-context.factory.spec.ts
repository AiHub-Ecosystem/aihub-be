import { createRequestContext } from './request-context.factory';

describe('createRequestContext', () => {
  it('creates a bounded context with an abort signal and deadline', () => {
    const receivedAt = new Date('2026-09-07T00:00:00.000Z');
    const context = createRequestContext({
      requestId: 'req-123',
      receivedAt,
      deadlineMs: 5_000,
      organizationId: 'org-123',
      scopes: ['writing:grade'],
    });

    expect(context.requestId).toBe('req-123');
    expect(context.organizationId).toBe('org-123');
    expect(context.deadlineAt).toEqual(new Date('2026-09-07T00:00:05.000Z'));
    expect(context.scopes).toEqual(['writing:grade']);
    expect(context.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects an empty request id or invalid deadline', () => {
    expect(() =>
      createRequestContext({
        requestId: '',
        receivedAt: new Date(),
        deadlineMs: 5_000,
        scopes: [],
      }),
    ).toThrow('requestId');

    expect(() =>
      createRequestContext({
        requestId: 'req-123',
        receivedAt: new Date(),
        deadlineMs: 0,
        scopes: [],
      }),
    ).toThrow('deadlineMs');
  });
});
