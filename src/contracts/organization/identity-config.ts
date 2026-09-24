import { type Static, Type } from '@sinclair/typebox';

const PrivateJwkMembers = [
  Type.Not(Type.Object({ d: Type.Unknown() })),
  Type.Not(Type.Object({ p: Type.Unknown() })),
  Type.Not(Type.Object({ q: Type.Unknown() })),
  Type.Not(Type.Object({ dp: Type.Unknown() })),
  Type.Not(Type.Object({ dq: Type.Unknown() })),
  Type.Not(Type.Object({ qi: Type.Unknown() })),
  Type.Not(Type.Object({ oth: Type.Unknown() })),
  Type.Not(Type.Object({ k: Type.Unknown() })),
];

const PublicJsonWebKeySchema = Type.Intersect([
  Type.Record(Type.String(), Type.Unknown()),
  ...PrivateJwkMembers,
]);

const PublicJsonWebKeySetSchema = Type.Object(
  { keys: Type.Array(PublicJsonWebKeySchema, { minItems: 1 }) },
  { additionalProperties: false },
);

const ConfiguredOrganizationIdentityConfigSchema = Type.Object(
  {
    configured: Type.Literal(true),
    issuer: Type.String({ minLength: 1 }),
    jwks_url: Type.Union([
      Type.String({ minLength: 1, format: 'uri' }),
      Type.Null(),
    ]),
    public_keys_jwks: Type.Union([PublicJsonWebKeySetSchema, Type.Null()]),
    allowed_algorithms: Type.Array(
      Type.Union([Type.Literal('RS256'), Type.Literal('ES256')]),
      { minItems: 1 },
    ),
    max_assertion_ttl_seconds: Type.Integer({ minimum: 1, maximum: 3_600 }),
    status: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
    updated_at: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);

const UnconfiguredOrganizationIdentityConfigSchema = Type.Object(
  { configured: Type.Literal(false) },
  { additionalProperties: false },
);

export const ReadOrganizationIdentityConfigResponseSchema = Type.Object(
  {
    data: Type.Union([
      ConfiguredOrganizationIdentityConfigSchema,
      UnconfiguredOrganizationIdentityConfigSchema,
    ]),
    meta: Type.Object(
      { request_id: Type.String({ pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$' }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ReadOrganizationIdentityConfigResponse = Static<
  typeof ReadOrganizationIdentityConfigResponseSchema
>;
