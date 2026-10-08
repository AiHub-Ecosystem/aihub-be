import { Type } from '@sinclair/typebox';

import { AppError } from '@/common/errors/app-error';
import { parseRequestBody } from './parse-request-body';

const Schema = Type.Object({
  name: Type.String(),
  test_type: Type.Optional(
    Type.Union([Type.Literal('Practice'), Type.Literal('Mock')], {
      default: 'Practice',
    }),
  ),
});

describe('parseRequestBody', () => {
  it('applies the schema defaults the caller left out', () => {
    expect(parseRequestBody(Schema, { name: 'bai' })).toEqual({
      name: 'bai',
      test_type: 'Practice',
    });
  });

  it('rejects a wrong-typed field instead of coercing it', () => {
    // Value.Parse alone would convert this to { name: '1' } and pass.
    expect(() => parseRequestBody(Schema, { name: 1 })).toThrow(AppError);
  });

  it('rejects a body that fails its schema with the uniform public error', () => {
    let thrown: unknown;
    try {
      parseRequestBody(Schema, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Request failed validation',
      retryable: false,
    });
  });

  it('reads a request with no body as an empty body', () => {
    expect(
      parseRequestBody(
        Type.Object({}, { additionalProperties: false }),
        undefined,
      ),
    ).toEqual({});
  });

  it('rejects a body a client sent as null', () => {
    expect(() =>
      parseRequestBody(Type.Object({}, { additionalProperties: false }), null),
    ).toThrow(AppError);
  });

  it('keeps a supplied value instead of the default', () => {
    expect(
      parseRequestBody(Schema, { name: 'bai', test_type: 'Mock' }),
    ).toEqual({
      name: 'bai',
      test_type: 'Mock',
    });
  });
});
