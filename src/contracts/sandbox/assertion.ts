import { type Static, Type } from '@sinclair/typebox';

/**
 * The end-user identifier is the only value the caller controls. It travels
 * into the `sub` claim, request logs, and metering, so it is bounded here at
 * the transport boundary rather than deeper in. The ceiling is well under the
 * 256-character limit `UserAssertionVerifier` enforces on bounded claims, and
 * the character set excludes anything that could confuse a log reader.
 */
export const SandboxUserIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9_-]+$',
});

export const MintSandboxAssertionRequestSchema = Type.Object(
  {
    user_id: SandboxUserIdSchema,
  },
  { additionalProperties: false },
);

export type MintSandboxAssertionRequest = Static<
  typeof MintSandboxAssertionRequestSchema
>;

/**
 * `expires_at` is seconds since the epoch, matching the `exp` claim it is read
 * from, so a caller can decide whether a cached assertion is still usable
 * without decoding the token.
 */
export const MintSandboxAssertionResponseSchema = Type.Object(
  {
    assertion: Type.String(),
    user_id: SandboxUserIdSchema,
    expires_at: Type.Integer(),
  },
  { additionalProperties: false },
);

export type MintSandboxAssertionResponse = Static<
  typeof MintSandboxAssertionResponseSchema
>;
