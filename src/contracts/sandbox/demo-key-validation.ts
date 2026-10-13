import { type Static, Type } from '@sinclair/typebox';

export const SandboxDemoScopeSchema = Type.Union([
  Type.Literal('writing.grade'),
  Type.Literal('speaking.grade'),
]);

/** The environments the public demo selects between. */
export const SandboxDemoEnvironmentSchema = Type.Union([
  Type.Literal('sandbox'),
  Type.Literal('production'),
]);

/** The environment the demo opens on when the request names none. */
export const DEFAULT_SANDBOX_DEMO_ENVIRONMENT = 'sandbox';

const SandboxDemoEnvironmentSchemaWithDefault = Type.Union(
  SandboxDemoEnvironmentSchema.anyOf,
  { default: DEFAULT_SANDBOX_DEMO_ENVIRONMENT },
);

export const SandboxDemoKeyValidationRequestSchema = Type.Object(
  {
    // The demo defaults to Sandbox; the default applies because the body is
    // parsed rather than only checked.
    environment: Type.Optional(SandboxDemoEnvironmentSchemaWithDefault),
    scope: SandboxDemoScopeSchema,
  },
  { additionalProperties: false },
);

/**
 * The Organization's Sandbox allowance as it stands right now. Advisory only:
 * validation reserves nothing, so this can be stale by the next grade.
 */
export const SandboxDemoAllowanceSchema = Type.Object(
  {
    monthly_limit: Type.Integer({ minimum: 0 }),
    reserved: Type.Integer({ minimum: 0 }),
    shared_monthly_limit: Type.Integer({ minimum: 0 }),
    shared_reserved: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SandboxDemoKeyValidationResponseSchema = Type.Object(
  {
    valid: Type.Literal(true),
    environment: SandboxDemoEnvironmentSchema,
    scope: SandboxDemoScopeSchema,
    /** Absent in Production, and in Sandbox when the policy store cannot be read. */
    allowance: Type.Union([SandboxDemoAllowanceSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export type SandboxDemoScope = Static<typeof SandboxDemoScopeSchema>;
export type SandboxDemoEnvironment = Static<
  typeof SandboxDemoEnvironmentSchema
>;
export type SandboxDemoKeyValidationRequest = Static<
  typeof SandboxDemoKeyValidationRequestSchema
>;
export type SandboxDemoKeyValidationResponse = Static<
  typeof SandboxDemoKeyValidationResponseSchema
>;
