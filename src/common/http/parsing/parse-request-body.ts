import { invalidRequest } from '@/common/errors/invalid-request';
import type { StaticDecode, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyRequest } from 'fastify';

import { containsUnstorableText } from './unstorable-text';

/**
 * Whether the caller proved an identity, which decides if a rejection may name
 * the failing field back to it.
 */
export function callerIsAuthenticated(request?: FastifyRequest): boolean {
  return (
    request?.aihubAuth !== undefined || request?.aihubIdentity !== undefined
  );
}

export function parseRequestBody<S extends TSchema>(
  schema: S,
  body: unknown,
  request?: FastifyRequest,
): StaticDecode<S> {
  const candidate = body === undefined ? {} : body;

  const authenticated = callerIsAuthenticated(request);

  if (!Value.Check(schema, candidate) || containsUnstorableText(candidate)) {
    const errors = [...Value.Errors(schema, candidate)];
    const paths = errors.map((error) => ({
      path: error.path === '' ? '/' : error.path,
      reason: error.message,
    }));
    const details = Object.fromEntries(
      paths.map((entry) => [entry.path, entry.reason]),
    );
    const diagnostic = JSON.stringify({ paths });
    throw invalidRequest(
      undefined,
      authenticated ? details : undefined,
      diagnostic,
    );
  }
  try {
    return Value.Parse(schema, candidate);
  } catch (error) {
    throw invalidRequest(error);
  }
}
