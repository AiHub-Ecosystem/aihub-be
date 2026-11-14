import type { StaticDecode, TSchema } from '@sinclair/typebox';

import { parseRequestQuery } from './parse-request-query';

/**
 * Validate the request headers a route reads against its schema. A header is
 * as untrusted as a query value, so the same refusal applies. The schema must
 * allow additional properties: every request carries headers the route ignores.
 */
export function parseRequestHeaders<S extends TSchema>(
  schema: S,
  headers: unknown,
): StaticDecode<S> {
  return parseRequestQuery(schema, headers);
}
