import { invalidRequest } from '@/common/errors/invalid-request';
import type { StaticDecode, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * The single way a presentation layer turns a raw request body into the value
 * its operation's TypeBox contract describes.
 *
 * Checking first is not redundant with parsing: the default parse pipeline
 * converts before it asserts, so `{ byte_size: '999' }` would decode to
 * `{ byte_size: 999 }` and pass. The check rejects the body as sent; the parse
 * that follows applies the schema's `default` values, so a contract declaring
 * one means the same thing on every route instead of only where a controller
 * happened to parse. A rejected body raises the uniform public error, and the
 * decode failure travels as its cause for the log, never for the caller.
 *
 * A route whose schema accepts an empty body passes `undefined` when the
 * request carries none, which Fastify is entitled to do; that becomes `{}` here
 * so every such route answers the same way. `null` is left alone: a client that
 * sends it has not sent an empty body.
 */
export function parseRequestBody<S extends TSchema>(
  schema: S,
  body: unknown,
): StaticDecode<S> {
  const candidate = body === undefined ? {} : body;

  if (!Value.Check(schema, candidate)) {
    throw invalidRequest();
  }
  try {
    return Value.Parse(schema, candidate);
  } catch (error) {
    throw invalidRequest(error);
  }
}
