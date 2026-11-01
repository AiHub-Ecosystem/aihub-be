import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import {
  MAX_DEADLINE_MS,
  createRequestContext,
} from './request-context.factory';

describe('createRequestContext', () => {
  it('accepts the deadline of every catalog operation, including the 125-second Writing /v2 grading', () => {
    for (const { timeoutMs } of Object.values(OPERATION_CATALOG)) {
      expect(() =>
        createRequestContext({
          requestId: 'req-123',
          receivedAt: new Date(),
          deadlineMs: timeoutMs,
          scopes: [],
        }),
      ).not.toThrow();
    }
    expect(MAX_DEADLINE_MS).toBeGreaterThanOrEqual(125_000);
  });

  it('creates a bounded context with an abort signal and deadline', () => {
    const receivedAt = new Date('2026-09-07T00:00:00.000Z');
    const context = createRequestContext({
      requestId: 'req-123',
      receivedAt,
      deadlineMs: 5_000,
      organizationId: 'org-123',
      identityMode: 'signed_assertion',
      scopes: ['writing:grade'],
    });

    expect(context.requestId).toBe('req-123');
    expect(context.organizationId).toBe('org-123');
    expect(context.identityMode).toBe('signed_assertion');
    expect(context.operationTimeoutMs).toBe(5_000);
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
