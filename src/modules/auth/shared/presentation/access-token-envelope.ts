import { AppError } from '@/common/errors/app-error';
import {
  type LoginResponse,
  LoginResponseSchema,
} from '@/contracts/auth/local-auth';
import { Value } from '@sinclair/typebox/value';

export function accessTokenEnvelope(
  token: string,
  expiresIn: number,
  requestId: string,
): LoginResponse {
  const response = {
    data: { access_token: token, token_type: 'Bearer', expires_in: expiresIn },
    meta: { request_id: requestId },
  };
  if (!Value.Check(LoginResponseSchema, response)) {
    // arch-check: validates a response to answer INTERNAL_ERROR
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Access token response is invalid',
      retryable: false,
    });
  }
  return response;
}
