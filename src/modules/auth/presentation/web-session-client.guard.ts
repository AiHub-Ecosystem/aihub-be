import { AppError } from '@/common/errors/app-error';
import { clientSecretFrom } from '@/common/http/client-secret-header';
import { constantTimeEquals } from '@/common/security/constant-time-equals';
import {
  WEB_SESSION_CLIENT_SECRET,
  type WebSessionClientSecretPort,
} from '@/modules/auth/application/web-session-client-secret.port';
import { webSessionUnavailable } from '@/modules/auth/application/web-session-errors';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Authenticates the BFF before controller validation or application lookups. */
@Injectable()
export class WebSessionClientGuard implements CanActivate {
  constructor(
    @Inject(WEB_SESSION_CLIENT_SECRET)
    private readonly secret: WebSessionClientSecretPort,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    // Nest's response decorators run after guards, so refusals set this here.
    http.getResponse<FastifyReply>().header('Cache-Control', 'no-store');
    const expected = this.secret.resolve();
    if (expected === undefined || expected.length === 0) {
      throw webSessionUnavailable(
        new Error('no Customer Web BFF client secret is provisioned'),
      );
    }
    const presented = clientSecretFrom(http.getRequest<FastifyRequest>());
    if (presented === undefined || !constantTimeEquals(presented, expected)) {
      throw new AppError({
        code: 'UNAUTHORIZED',
        message: 'Client secret is missing or invalid',
        retryable: false,
      });
    }
    http.getRequest<FastifyRequest>().aihubClientIpSource = 'customer_web_bff';
    return true;
  }
}
