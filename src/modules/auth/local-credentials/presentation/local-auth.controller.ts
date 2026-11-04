import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { AppError } from '@/common/errors/app-error';
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
import { requestIp } from '@/modules/auth/shared/presentation/auth-request';
import {
  clearRefreshCookie,
  sessionEnvelope,
} from '@/modules/auth/shared/presentation/session-transport';
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
  async login(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResultResponse> {
    const input = parseRequestBody(LoginRequestSchema, body, request);
    const result = await this.sessions.login(input, requestIp(request));
    if (result.kind === 'mfa-required') {
      reply.status(202);
      return {
        data: { status: 'MFA_REQUIRED' },
        meta: { request_id: String(request.id) },
      };
    }
    return sessionEnvelope(request, reply, result.session);
  }

  @Post(PUBLIC_ROUTES['auth.refresh'].path)
  @HttpCode(PUBLIC_ROUTES['auth.refresh'].successStatus)
  async refresh(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
    parseRequestBody(EmptyAuthRequestSchema, body, request);
    const rawToken = hasAlternateRefreshSource(request)
      ? undefined
      : refreshCookieFrom(request);

    try {
      const result = await this.sessions.refresh(rawToken, requestIp(request));
      return sessionEnvelope(request, reply, result);
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
  async logout(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    parseRequestBody(EmptyAuthRequestSchema, body, request);
    const rawToken = hasAlternateRefreshSource(request)
      ? undefined
      : refreshCookieFrom(request);
    await this.sessions.logout(rawToken);
    clearRefreshCookie(reply);
  }
}
