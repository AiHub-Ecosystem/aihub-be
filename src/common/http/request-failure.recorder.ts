import type { ErrorCode } from '../errors/error-code';

/**
 * The public error code one component reports for the request it is about to
 * answer.
 *
 * Two components answer a request with an error without the exception filter
 * running: the filter itself, and the oversized-body guard, which replies
 * before Nest sees the request at all. Keying by the underlying Node request,
 * the way the request-tracing and request-lifecycle hooks key their own state,
 * lets both report here so the Request Completion Event can name the same code
 * the caller received, instead of one guessed from the status afterwards.
 */
const failureCodeByRequest = new WeakMap<object, ErrorCode>();

export function recordRequestFailure(
  rawRequest: unknown,
  errorCode: ErrorCode,
): void {
  if (isObject(rawRequest)) {
    failureCodeByRequest.set(rawRequest, errorCode);
  }
}

export function readRequestFailure(rawRequest: unknown): ErrorCode | undefined {
  return isObject(rawRequest)
    ? failureCodeByRequest.get(rawRequest)
    : undefined;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
