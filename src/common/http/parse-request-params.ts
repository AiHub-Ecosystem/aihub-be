import type { StaticDecode, TSchema } from '@sinclair/typebox';

import { parseRequestQuery } from './parse-request-query';

/**
 * Validate the route's path parameters against a closed schema. A path
 * parameter is as untrusted as a query value, so the same refusal applies.
 */
export function parseRequestParams<S extends TSchema>(
  schema: S,
  params: unknown,
): StaticDecode<S> {
  return parseRequestQuery(schema, params);
}
