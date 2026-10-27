import { AppError } from '@/common/errors/app-error';

/**
 * The error every downstream response adapter throws when the provider's body
 * breaks its contract. `reason` reaches the log as the diagnostic, so it names
 * fields and kinds of mismatch and never a value from the provider's response.
 */
export function contractViolation(reason: string): AppError {
  return new AppError({
    code: 'AI_SERVICE_CONTRACT_VIOLATION',
    message: 'AI service returned an unexpected response shape',
    retryable: false,
    diagnostic: reason,
    cause: new Error(reason),
  });
}
