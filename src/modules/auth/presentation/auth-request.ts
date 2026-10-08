import { invalidRequest } from '@/common/errors/invalid-request';
import type { StaticDecode, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyRequest } from 'fastify';

export function parseAuthBody<S extends TSchema>(
  schema: S,
  body: unknown,
): StaticDecode<S> {
  if (!Value.Check(schema, body)) {
    throw invalidRequest();
  }
  try {
    return Value.Parse(schema, body);
  } catch (error) {
    throw invalidRequest(error);
  }
}

export function requestIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}
