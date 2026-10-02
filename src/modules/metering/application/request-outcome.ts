import { AppError } from '../../../common/errors/app-error';
import type { ErrorCode } from '../../../common/errors/error-code';
import type { MeteringOutcome } from './metering-finalizer.port';

/**
 * One vocabulary for how a request ended. The Metering record and the Request
 * Completion Event both answer with these four words, and they are derived
 * here so an operator never has to translate between two sets.
 */

/**
 * Every downstream failure AIHUB raises carries an `AI_SERVICE_*` code — today
 * `AI_SERVICE_ERROR` is also the only error that carries `downstreamStatus`, so
 * this recognises exactly the requests `isDownstreamFailure` does.
 */
export function isDownstreamCode(errorCode: ErrorCode): boolean {
  return errorCode.startsWith('AI_SERVICE_');
}

export function isDownstreamFailure(exception: unknown): boolean {
  return (
    exception instanceof AppError &&
    (exception.downstreamStatus !== undefined ||
      isDownstreamCode(exception.code))
  );
}

/**
 * What the Metering record records for a failed request. Unchanged in shape:
 * a request that reached here failed, so `success` is never one of the answers.
 */
export function meteringOutcome(
  exception: unknown,
  statusCode: number,
): MeteringOutcome {
  if (isDownstreamFailure(exception)) {
    return 'downstream_error';
  }
  return statusCode >= 500 ? 'internal_error' : 'client_error';
}

/**
 * The same vocabulary for the completion line, which starts from the public
 * error code the caller was sent rather than from the exception. A response
 * below 400 succeeded, and nothing recorded a failure to contradict it.
 */
export function completionOutcome(
  statusCode: number,
  errorCode: ErrorCode | undefined,
): MeteringOutcome {
  if (errorCode !== undefined && isDownstreamCode(errorCode)) {
    return 'downstream_error';
  }
  if (statusCode < 400) {
    return 'success';
  }
  return statusCode >= 500 ? 'internal_error' : 'client_error';
}
