import type { OperationId } from '../../../catalog/operation-id';
import { AppError } from '../../../common/errors/app-error';
import type { RequestContext } from '../../../common/request-context/request-context';
import type { InternalTokenIssuerPort } from '../application/internal-token-issuer.port';

/**
 * Phase 1 credential provider. Phase 2 can replace this implementation with
 * an AIHUB-signed short-lived JWT without changing the dispatcher port.
 */
export class ConfiguredTokenIssuer implements InternalTokenIssuerPort {
  constructor(private readonly token: string) {}

  async mint(
    _context: RequestContext,
    _operation: OperationId,
  ): Promise<string> {
    if (this.token.trim().length === 0) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Downstream authentication is not configured',
        httpStatus: 500,
        retryable: false,
      });
    }

    return this.token;
  }
}
