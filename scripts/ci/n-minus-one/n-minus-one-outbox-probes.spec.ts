import { classifyUnrecognisedKindRow } from './n-minus-one-outbox-probes';

const UNTOUCHED = {
  status: 'queued',
  attempts: 0,
  payload_ciphertext: 'opaque-fixture',
};

describe('classifyUnrecognisedKindRow', () => {
  it('passes a row N-1 left queued and unattempted', () => {
    expect(classifyUnrecognisedKindRow(UNTOUCHED).kind).toBe('pass');
  });

  it.each([
    ['failed', { ...UNTOUCHED, status: 'failed', payload_ciphertext: null }],
    [
      'cancelled',
      { ...UNTOUCHED, status: 'cancelled', payload_ciphertext: null },
    ],
    ['attempted', { ...UNTOUCHED, attempts: 1 }],
    ['payload erased', { ...UNTOUCHED, payload_ciphertext: null }],
  ])('fails a row N-1 %s', (_name, row) => {
    expect(classifyUnrecognisedKindRow(row).kind).toBe('fail');
  });

  it('fails when the row is gone', () => {
    expect(classifyUnrecognisedKindRow(undefined).kind).toBe('fail');
  });
});
