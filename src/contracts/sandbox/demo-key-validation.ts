import { type Static, Type } from '@sinclair/typebox';

export const SandboxDemoScopeSchema = Type.Union([
  Type.Literal('writing.grade'),
  Type.Literal('speaking.grade'),
]);

export const SandboxDemoKeyValidationRequestSchema = Type.Object(
  { scope: SandboxDemoScopeSchema },
  { additionalProperties: false },
);

export const SandboxDemoKeyValidationResponseSchema = Type.Object(
  {
    valid: Type.Literal(true),
    environment: Type.Literal('sandbox'),
    scope: SandboxDemoScopeSchema,
  },
  { additionalProperties: false },
);

export type SandboxDemoScope = Static<typeof SandboxDemoScopeSchema>;
export type SandboxDemoKeyValidationRequest = Static<
  typeof SandboxDemoKeyValidationRequestSchema
>;
export type SandboxDemoKeyValidationResponse = Static<
  typeof SandboxDemoKeyValidationResponseSchema
>;
