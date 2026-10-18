import { invalidRequest } from '@/common/errors/invalid-request';
import type { StaticDecode, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyRequest } from 'fastify';

import { containsUnstorableText } from './unstorable-text';

export function parseRequestBody<S extends TSchema>(
  schema: S,
  body: unknown,
  request?: FastifyRequest,
): StaticDecode<S> {
  const candidate = body === undefined ? {} : body;

  const authenticated =
    request?.aihubAuth !== undefined || request?.aihubIdentity !== undefined;

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
