import {
  ADDITIVE_FIXTURE_VALUE,
  classifyAdditiveBoot,
  withAdditiveDocumentKey,
} from './n-minus-one-vault-rehearsal';

describe('withAdditiveDocumentKey', () => {
  it('keeps every known bundle and adds one key beside them', () => {
    const document = JSON.stringify({ resend: { api_key: 'k' } });

    expect(JSON.parse(withAdditiveDocumentKey(document))).toEqual({
      resend: { api_key: 'k' },
      'rehearsal-additive': { value: ADDITIVE_FIXTURE_VALUE },
    });
  });
});

describe('classifyAdditiveBoot', () => {
  it('treats an N-1 that exited as a strict reader', () => {
    expect(
      classifyAdditiveBoot({ exited: true, output: 'unsupported key' }).kind,
    ).toBe('rejected');
  });

  it('treats an N-1 that kept running as a tolerant reader', () => {
    expect(classifyAdditiveBoot({ exited: false, output: '' }).kind).toBe(
      'accepted',
    );
  });

  it.each([true, false])(
    'fails whenever the fixture value reaches the output (exited: %s)',
    (exited) => {
      expect(
        classifyAdditiveBoot({
          exited,
          output: `document has ${ADDITIVE_FIXTURE_VALUE}`,
        }).kind,
      ).toBe('leaked');
    },
  );
});
