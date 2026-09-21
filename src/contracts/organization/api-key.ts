import { FormatRegistry, type Static, Type } from '@sinclair/typebox';

// TypeBox rejects an unregistered format outright, so `date-time` has to be
// taught once before any boundary can validate a timestamp against it.
if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set(
    'date-time',
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) && !Number.isNaN(Date.parse(value)),
  );
}

/**
 * The lifecycle the API publishes, which is wider than the durable column:
 * `expired` is derived from the key's expiry moment rather than stored. A
 * creation response never carries it, because a requested expiry must be in
 * the future.
 */
const ApiKeyStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('expired'),
  Type.Literal('revoked'),
]);

/**
 * The Environments a customer may bind a key to. AIHUB's own sandbox and
 * development tiers are deliberately absent: they are not customer tiers.
 */
export const CustomerEnvironmentSchema = Type.Union([
  Type.Literal('production'),
  Type.Literal('staging'),
]);

export type CustomerEnvironment = Static<typeof CustomerEnvironmentSchema>;

export const CreateOrganizationApiKeyRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    scopes: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    allowed_environments: Type.Optional(
      Type.Array(CustomerEnvironmentSchema, { minItems: 1 }),
    ),
    expires_at: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
);

export type CreateOrganizationApiKeyRequest = Static<
  typeof CreateOrganizationApiKeyRequestSchema
>;

/**
 * The safe metadata view of an organization API key. Listing reuses this shape,
 * so the two endpoints cannot describe the same key differently.
 */
export const OrganizationApiKeySchema = Type.Object(
  {
    id: Type.String({ pattern: '^ak_[0-9A-HJKMNP-TV-Z]{26}$' }),
    name: Type.String({ minLength: 1 }),
    key_prefix: Type.String({ minLength: 1 }),
    scopes: Type.Array(Type.String({ minLength: 1 })),
    allowed_environments: Type.Array(Type.String({ minLength: 1 })),
    status: ApiKeyStatusSchema,
    expires_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    /**
     * Approximate: the authenticator's touch is throttled and issued
     * fire-and-forget, so this can lag a live key's real last use.
     */
    last_used_at: Type.Union([
      Type.String({ format: 'date-time' }),
      Type.Null(),
    ]),
    created_at: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);

export type OrganizationApiKey = Static<typeof OrganizationApiKeySchema>;

/**
 * The response of every operation that mints a credential: creation and
 * rotation both return it, which is why the name says neither.
 *
 * `api_key` carries the raw credential, returned here and nowhere else, ever.
 * The field name matches the centralized redaction key set on purpose, so a
 * record that reaches a logger is redacted by the mechanism rather than by
 * remembering to.
 */
export const OrganizationApiKeySecretResponseSchema = Type.Object(
  {
    // `Composite`, not `Intersect`: an `allOf` of two closed objects is
    // unsatisfiable, so every real response would fail the published contract.
    data: Type.Composite(
      [
        Type.Object({
          api_key: Type.String({ pattern: '^aihub_sk_[A-Za-z0-9]{43}$' }),
        }),
        OrganizationApiKeySchema,
      ],
      { additionalProperties: false },
    ),
    meta: Type.Object(
      { request_id: Type.String({ pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$' }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type OrganizationApiKeySecretResponse = Static<
  typeof OrganizationApiKeySecretResponseSchema
>;

/**
 * The live-credential inventory: revoked keys are absent, so the response is
 * bounded by the active-key cap and needs no pagination.
 */
export const ListOrganizationApiKeysResponseSchema = Type.Object(
  {
    data: Type.Object(
      { api_keys: Type.Array(OrganizationApiKeySchema) },
      { additionalProperties: false },
    ),
    meta: Type.Object(
      { request_id: Type.String({ pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$' }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ListOrganizationApiKeysResponse = Static<
  typeof ListOrganizationApiKeysResponseSchema
>;

/**
 * The withdrawn key. This is the only response from which the published
 * `revoked` status is reachable: listing omits revoked keys, and creation and
 * rotation return only active ones. `revoked_at` is deliberately absent — it
 * would be null in every other response carrying this shape, and when a key
 * was revoked belongs to the durable audit follow-up.
 */
export const RevokeOrganizationApiKeyResponseSchema = Type.Object(
  {
    data: OrganizationApiKeySchema,
    meta: Type.Object(
      { request_id: Type.String({ pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$' }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type RevokeOrganizationApiKeyResponse = Static<
  typeof RevokeOrganizationApiKeyResponseSchema
>;
