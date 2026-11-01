import { idempotencyMode } from './idempotency-operation';

describe('idempotencyMode', () => {
  it('uses the injected retrieval operation policy', () => {
    expect(
      idempotencyMode('speaking.v2.responses.get', {
        'speaking.v2.responses.get': { idempotency: 'none' },
      }),
    ).toBe('none');
  });
});
