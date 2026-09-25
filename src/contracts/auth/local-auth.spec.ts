import { type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  LoginRequestSchema,
  RegisterRequestSchema,
  ResetPasswordRequestSchema,
} from './local-auth';

type RequestCase = {
  readonly name: string;
  readonly schema: TSchema;
  readonly body: (password: string) => Record<string, string>;
};

const requestCases: readonly RequestCase[] = [
  {
    name: 'register',
    schema: RegisterRequestSchema,
    body: (password) => ({
      email: 'person@example.com',
      username: 'person_01',
      password,
    }),
  },
  {
    name: 'login',
    schema: LoginRequestSchema,
    body: (password) => ({
      email: 'person@example.com',
      password,
    }),
  },
  {
    name: 'reset-password',
    schema: ResetPasswordRequestSchema,
    body: (password) => ({
      token: 'reset-token',
      password,
    }),
  },
];

const boundaryCases = requestCases.flatMap(({ name, schema, body }) =>
  [11, 12, 128, 129].flatMap((length) =>
    ['a', '😀'].map((character) => ({
      name,
      schema,
      body: body(character.repeat(length)),
      expected: length >= 12 && length <= 128,
    })),
  ),
);

describe('local auth request contracts', () => {
  it.each(boundaryCases)(
    '$name validates the password boundary',
    ({ schema, body, expected }) => {
      expect(Value.Check(schema, body)).toBe(expected);
    },
  );
});
