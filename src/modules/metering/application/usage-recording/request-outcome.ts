import type { ErrorCode } from '@/common/errors/error-code';
import type { MeteringOutcome } from './metering-finalizer.port';

/**
 * How a request ended, in the one vocabulary the Metering record and the
 * Request Completion Event share. Both derive it here from the status and the
 * public error code the caller received, so a request cannot be recorded as
 * one outcome and logged as another.
 *
 * Every downstream failure AIHUB raises carries an `AI_SERVICE_*` code, so the
 * code alone says whether the fault was downstream. A response below 400
 * succeeded, and no error code contradicts it.
 */
export function requestOutcome(
  statusCode: number,
  errorCode: ErrorCode | undefined,
): MeteringOutcome {
  if (errorCode?.startsWith('AI_SERVICE_')) {
    return 'downstream_error';
  }
  if (statusCode < 400) {
    return 'success';
  }
  return statusCode >= 500 ? 'internal_error' : 'client_error';
}
