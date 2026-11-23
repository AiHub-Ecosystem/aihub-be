import { invalidRequest } from '@/common/errors/invalid-request';
import type { StaticDecode, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export function parseRequestQuery<S extends TSchema>(
  schema: S,
  query: unknown,
): StaticDecode<S> {
  const candidate = query === undefined ? {} : query;

  if (!Value.Check(schema, candidate)) {
    throw invalidRequest();
  }

  try {
    return Value.Parse(schema, candidate);
  } catch (error) {
    throw invalidRequest(error);
  }
}
