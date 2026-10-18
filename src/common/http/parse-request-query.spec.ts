import { Type } from '@sinclair/typebox';

import { AppError } from '@/common/errors/app-error';
import { parseRequestQuery } from './parse-request-query';

const QuerySchema = Type.Object(
  {
    part: Type.Optional(
      Type.Union([Type.Literal('1'), Type.Literal('2'), Type.Literal('3')]),
    ),
    action: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

describe('parseRequestQuery', () => {
  it('returns declared query values, including a repeated list value', () => {
    expect(
      parseRequestQuery(QuerySchema, {
        part: '2',
        action: ['organization.created', 'organization.renamed'],
      }),
    ).toEqual({
      part: '2',
      action: ['organization.created', 'organization.renamed'],
    });
  });

  it('accepts a missing query only when the schema accepts an empty object', () => {
    expect(
      parseRequestQuery(
        Type.Object({}, { additionalProperties: false }),
        undefined,
      ),
    ).toEqual({});
  });

  it('rejects an undeclared name with the uniform public error', () => {
    let thrown: unknown;
    try {
      parseRequestQuery(QuerySchema, { actoin: 'organization.created' });
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

  it('rejects repeated occurrences of a single-valued parameter', () => {
    expect(() => parseRequestQuery(QuerySchema, { part: ['1', '2'] })).toThrow(
      AppError,
    );
  });

  it('rejects null instead of treating it as a missing query', () => {
    expect(() => parseRequestQuery(QuerySchema, null)).toThrow(AppError);
  });

  it('rejects all parameters against an empty closed schema', () => {
    expect(() =>
      parseRequestQuery(Type.Object({}, { additionalProperties: false }), {
        part: '1',
      }),
    ).toThrow(AppError);
  });
});
