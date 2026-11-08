import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { AppError, internalError } from '@/common/errors/app-error';
import { parseRequestBody } from '@/common/http/parse-request-body';
import {
  EmptyAuthRequestSchema,
  LoginRequestSchema,
  type LoginResponse,
  type LoginResultResponse,
  RegisterRequestSchema,
} from '@/contracts/auth/local-auth';
import {
  LOCAL_REGISTRATION,
  type LocalRegistrationPort,
} from '@/modules/auth/local-credentials/application/local-registration.port';
import {
  LOCAL_SESSION,
  type LocalSessionPort,
  RefreshRotationCommittedError,
} from '@/modules/auth/local-credentials/application/local-session.port';
import {
  invalidCredentials,
  invalidRefreshToken,
} from '@/modules/auth/shared/application/local-auth-errors';
import {
  credentialIp,
  requestIp,
} from '@/modules/auth/shared/presentation/auth-request';
import {
  csrfTokenFrom,
  csrfTokenMatches,
  preLoginCsrfToken,
  sessionCsrfToken,
} from '@/modules/auth/shared/presentation/cross-site-csrf';
import {
  clearRefreshCookie,
  sessionEnvelope,
} from '@/modules/auth/shared/presentation/session-transport';
import {
  WEB_SESSION_CLIENT_SECRET,
  type WebSessionClientSecretPort,
} from '@/modules/auth/web-sessions/application/web-session-client-secret.port';
import { OptionalWebSessionClientGuard } from '@/modules/auth/web-sessions/public';
import {
  hasAlternateRefreshSource,
  refreshCookieFrom,
} from '@/modules/auth/web-sessions/public/refresh-cookie';

interface RegisterEnvelope {
  readonly data: {
    readonly email: string;
    readonly username: string;
    readonly status: 'pending_verification';
    readonly email_delivery_status: 'queued' | 'suppressed';
  };
  readonly meta: { readonly request_id: string };
}

function isInvalidRefreshToken(error: unknown): boolean {
  return (
    error instanceof AppError && error.code === 'AUTH_REFRESH_TOKEN_INVALID'
  );
}

@Controller()
export class LocalAuthController {
  constructor(
    @Inject(LOCAL_REGISTRATION)
    private readonly registration: LocalRegistrationPort,
    @Inject(LOCAL_SESSION)
    private readonly sessions: LocalSessionPort,
    @Inject(WEB_SESSION_CLIENT_SECRET)
    private readonly clientSecret: WebSessionClientSecretPort,
  ) {}

  @Post(PUBLIC_ROUTES['auth.register'].path)
  @HttpCode(PUBLIC_ROUTES['auth.register'].successStatus)
  async register(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<RegisterEnvelope> {
    const input = parseRequestBody(RegisterRequestSchema, body, request);
    const result = await this.registration.register(
      input,
      requestIp(request),
      input.browser_binding,
    );
    return {
      data: {
        email: result.email,
        username: result.username,
        status: result.status,
        email_delivery_status: result.emailDeliveryStatus,
      },
      meta: { request_id: String(request.id) },
    };
  }

  @Post(PUBLIC_ROUTES['auth.login'].path)
  @HttpCode(PUBLIC_ROUTES['auth.login'].successStatus)
  @UseGuards(OptionalWebSessionClientGuard)
  async login(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResultResponse> {
    const input = parseRequestBody(LoginRequestSchema, body, request);
    const forwarded = bffForwarded(request);
    // Cross-site BFF forwarding (ADR-0157): the request is server-to-server,
    // so the browser's SameSite=Strict never applies here. The BFF presents
    // its pre-login CSRF token and the end user's address instead; same-site
    // callers present neither and keep today's behavior byte for byte.
    const ip = forwarded ? credentialIp(request) : requestIp(request);
    if (forwarded && !this.preLoginCsrfValid(request)) {
      throw invalidCredentials();
    }
    const result = await this.sessions.login(input, ip);
    if (result.kind === 'mfa-required') {
      reply.status(202);
      return {
        data: { status: 'MFA_REQUIRED' },
        meta: { request_id: String(request.id) },
      };
    }
    return sessionEnvelope(
      request,
      reply,
      result.session,
      forwarded ? this.sessionCsrfFor(result.session.refreshToken) : undefined,
    );
  }

  @Post(PUBLIC_ROUTES['auth.refresh'].path)
  @HttpCode(PUBLIC_ROUTES['auth.refresh'].successStatus)
  @UseGuards(OptionalWebSessionClientGuard)
  async refresh(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
    parseRequestBody(EmptyAuthRequestSchema, body, request);
    const forwarded = bffForwarded(request);
    const rawToken = hasAlternateRefreshSource(request)
      ? undefined
      : refreshCookieFrom(request);

    // No end-user address means the BFF would rate-limit every one of its
    // users against one shared key (ADR-0081's rule for its routes), so a
    // forwarded refresh requires the address like a forwarded login does.
    const ip = forwarded ? credentialIp(request) : requestIp(request);
    if (forwarded) {
      // A CSRF failure refuses without clearing the cookie: clearing here
      // would let a CSRF probe that cannot produce the token still log the
      // victim's browser out.
      if (
        rawToken === undefined ||
        !csrfTokenMatches(csrfTokenFrom(request), this.sessionCsrfFor(rawToken))
      ) {
        throw invalidRefreshToken();
      }
    }

    try {
      const result = await this.sessions.refresh(rawToken, ip);
      return sessionEnvelope(
        request,
        reply,
        result,
        forwarded ? this.sessionCsrfFor(result.refreshToken) : undefined,
      );
    } catch (error) {
      if (isInvalidRefreshToken(error)) {
        clearRefreshCookie(reply);
      }
      if (error instanceof RefreshRotationCommittedError) {
        clearRefreshCookie(reply);
      }
      throw error;
    }
  }

  @Post(PUBLIC_ROUTES['auth.logout'].path)
  @HttpCode(PUBLIC_ROUTES['auth.logout'].successStatus)
  @UseGuards(OptionalWebSessionClientGuard)
  async logout(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    parseRequestBody(EmptyAuthRequestSchema, body, request);
    const forwarded = bffForwarded(request);
    const rawToken = hasAlternateRefreshSource(request)
      ? undefined
      : refreshCookieFrom(request);
    if (
      forwarded &&
      (rawToken === undefined ||
        !csrfTokenMatches(
          csrfTokenFrom(request),
          this.sessionCsrfFor(rawToken),
        ))
    ) {
      // Logout keeps its quiet contract: a forwarded call without the valid
      // CSRF token answers the same `204` and revokes nothing, so a probe
      // learns nothing and the session survives.
      return;
    }
    await this.sessions.logout(rawToken);
    clearRefreshCookie(reply);
  }

  private preLoginCsrfValid(request: FastifyRequest): boolean {
    return csrfTokenMatches(
      csrfTokenFrom(request),
      preLoginCsrfToken(this.csrfKey()),
    );
  }

  private sessionCsrfFor(refreshToken: string): string {
    return sessionCsrfToken(this.csrfKey(), refreshToken);
  }

  /** The guard has already authenticated the BFF, so the secret is provisioned. */
  private csrfKey(): string {
    const secret = this.clientSecret.resolve();
    if (secret === undefined || secret.length === 0) {
      throw internalError('no Customer Web BFF client secret is provisioned');
    }
    return secret;
  }
}

/** The client-secret guard marks an authenticated BFF request on the request. */
function bffForwarded(request: FastifyRequest): boolean {
  return request.aihubClientIpSource === 'customer_web_bff';
}
