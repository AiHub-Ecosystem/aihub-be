import { Type } from '@sinclair/typebox';

/** The shape `generateRequestId` mints: `req_` plus a 26-character ULID. */
export const REQUEST_ID_PATTERN = '^req_[0-9A-HJKMNP-TV-Z]{26}$';

export const RequestIdSchema = Type.String({ pattern: REQUEST_ID_PATTERN });

/** The `meta` object of a response that carries nothing but the request id. */
export const ResponseMetaSchema = Type.Object(
  { request_id: RequestIdSchema },
  { additionalProperties: false },
);

/** A page cursor, or `null` at the end of the collection. */
export const NextCursorSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Null(),
]);
