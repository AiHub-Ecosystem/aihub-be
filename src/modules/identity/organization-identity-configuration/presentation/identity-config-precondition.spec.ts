import { AppError } from '@/common/errors/app-error';

import {
  identityConfigEtag,
  parseIdentityConfigPrecondition,
} from './identity-config-precondition';

function refusal(headers: Record<string, string | string[] | undefined>) {
  let thrown: unknown;
  try {
    parseIdentityConfigPrecondition(headers);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  return thrown;
}

describe('identity configuration precondition headers (ADR-0132)', () => {
  it('formats a revision as a strong entity tag', () => {
    expect(identityConfigEtag('7')).toBe('"7"');
  });

  it('reads no precondition when neither header is sent', () => {
    expect(parseIdentityConfigPrecondition({})).toBeUndefined();
    expect(
      parseIdentityConfigPrecondition({ 'content-type': 'application/json' }),
    ).toBeUndefined();
  });

  it('reads If-Match as the revision the write is based on', () => {
    expect(parseIdentityConfigPrecondition({ 'if-match': '"7"' })).toEqual({
      kind: 'revision',
      revision: '7',
    });
    expect(parseIdentityConfigPrecondition({ 'if-match': '"1204"' })).toEqual({
      kind: 'revision',
      revision: '1204',
    });
  });

  it('reads If-None-Match: * as create-only', () => {
    expect(parseIdentityConfigPrecondition({ 'if-none-match': '*' })).toEqual({
      kind: 'absent',
    });
  });

  it.each([
    '7',
    'W/"7"',
    '*',
    '"0"',
    '"07"',
    '"-1"',
    '"abc"',
    '""',
    '"7", "8"',
    '"7" ',
    '',
  ])('refuses the If-Match value %j with INVALID_REQUEST', (value) => {
    expect(refusal({ 'if-match': value })).toMatchObject({
      code: 'INVALID_REQUEST',
      httpStatus: 400,
      details: {
        if_match: 'If-Match must be one quoted revision such as "7"',
      },
    });
  });

  it.each(['"7"', 'W/"7"', '', '*, *', 'x'])(
    'refuses the If-None-Match value %j with INVALID_REQUEST',
    (value) => {
      expect(refusal({ 'if-none-match': value })).toMatchObject({
        code: 'INVALID_REQUEST',
        httpStatus: 400,
        details: { if_none_match: 'If-None-Match must be *' },
      });
    },
  );

  it('refuses a repeated header', () => {
    expect(refusal({ 'if-match': ['"7"', '"8"'] })).toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(refusal({ 'if-none-match': ['*', '*'] })).toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('refuses a request that sends both headers', () => {
    expect(refusal({ 'if-match': '"7"', 'if-none-match': '*' })).toMatchObject({
      code: 'INVALID_REQUEST',
      details: {
        if_match: 'Send either If-Match or If-None-Match, not both',
      },
    });
  });
});
