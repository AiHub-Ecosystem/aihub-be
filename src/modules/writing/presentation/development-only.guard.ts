import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';

import { AppError } from '../../../common/errors/app-error';

/**
 * Temporary local-only auth seam. A real API-key guard must replace it before
 * any non-development deployment; production always fails closed.
 */
@Injectable()
export class DevelopmentOnlyGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (
      (process.env.NODE_ENV !== 'development' &&
        process.env.NODE_ENV !== 'test') ||
      process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV !== 'true'
    ) {
      throw new AppError({
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
        httpStatus: 401,
        retryable: false,
      });
    }

    return true;
  }
}
