import { AppError, internalError } from '@/common/errors/app-error';
import {
  WEB_SESSION_CLIENT_SECRET_HEADER,
  clientSecretFrom,
} from '@/common/http/client-secret-header';
import { constantTimeEquals } from '@/common/security/constant-time-equals';
import {
  AUTH_CLOCK,
  type AuthClock,
} from '@/modules/auth/shared/application/auth-clock';
import {
  AUTH_SECURITY_EVENT_RECORDER,
  type AuthSecurityEventRecorderPort,
} from '@/modules/auth/shared/application/auth-security-event.port';
import {
  WEB_SESSION_CLIENT_SECRET,
  type WebSessionClientSecretPort,
} from '@/modules/auth/web-sessions/application/web-session-client-secret.port';
import { webSessionUnavailable } from '@/modules/auth/web-sessions/application/web-session-errors';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

interface ClientAuthenticationDependencies {
  readonly secret: WebSessionClientSecretPort;
  readonly securityEvents: AuthSecurityEventRecorderPort;
  readonly clock: AuthClock;
}

/** Verifies the BFF secret, records rejections, and marks its IP as trusted. */
function authenticateClient(
  context: ExecutionContext,
  dependencies: ClientAuthenticationDependencies,
): boolean {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  const expected = dependencies.secret.resolve();
  if (expected === undefined || expected.length === 0) {
    throw webSessionUnavailable(
      internalError('no Customer Web BFF client secret is provisioned'),
    );
  }
  const presented = clientSecretFrom(request);
  if (presented === undefined || !constantTimeEquals(presented, expected)) {
    dependencies.securityEvents.record({
      event: 'web_session_client_secret_guard_failed',
      occurredAt: dependencies.clock.now(),
    });
    throw new AppError({
      code: 'UNAUTHORIZED',
      message: 'Client secret is missing or invalid',
      retryable: false,
    });
  }
  request.aihubClientIpSource = 'customer_web_bff';
  return true;
}

/** Authenticates the BFF before controller validation or application lookups. */
@Injectable()
export class WebSessionClientGuard implements CanActivate {
  constructor(
    @Inject(WEB_SESSION_CLIENT_SECRET)
    readonly secret: WebSessionClientSecretPort,
    @Inject(AUTH_SECURITY_EVENT_RECORDER)
    readonly securityEvents: AuthSecurityEventRecorderPort,
    @Inject(AUTH_CLOCK)
    readonly clock: AuthClock,
  ) {}
  canActivate(context: ExecutionContext): boolean {
    return authenticateClient(context, this);
  }
}

@Injectable()
export class OptionalWebSessionClientGuard implements CanActivate {
  constructor(
    @Inject(WEB_SESSION_CLIENT_SECRET)
    readonly secret: WebSessionClientSecretPort,
    @Inject(AUTH_SECURITY_EVENT_RECORDER)
    readonly securityEvents: AuthSecurityEventRecorderPort,
    @Inject(AUTH_CLOCK)
    readonly clock: AuthClock,
  ) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (
      request.headers[WEB_SESSION_CLIENT_SECRET_HEADER.toLowerCase()] ===
      undefined
    ) {
      return true;
    }
    return authenticateClient(context, this);
  }
}
