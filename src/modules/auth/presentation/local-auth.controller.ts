import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../../common/errors/app-error';
import { invalidRequest } from '../../../common/errors/invalid-request';
import {
  EmptyAuthRequestSchema,
  type ForgotPasswordRequest,
  ForgotPasswordRequestSchema,
  type LoginRequest,
  LoginRequestSchema,
  type RegisterRequest,
  RegisterRequestSchema,
  type ResendVerificationRequest,
  ResendVerificationRequestSchema,
  type ResetPasswordRequest,
  ResetPasswordRequestSchema,
  type VerifyEmailRequest,
  VerifyEmailRequestSchema,
} from '../../../contracts/auth/local-auth';
import {
  type IssuedSession,
  LOCAL_AUTH_SERVICE,
  type LocalAuthServicePort,
  RefreshRotationCommittedError,
} from '../application/local-auth-service.port';
import {
  REFRESH_COOKIE_CLEAR_OPTIONS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_OPTIONS,
  hasAlternateRefreshSource,
  refreshCookieFrom,
} from './refresh-cookie';

interface RegisterEnvelope {
  readonly data: {
    readonly email: string;
    readonly username: string;
    readonly status: 'pending_verification';
  };
  readonly meta: { readonly request_id: string };
}

interface LoginEnvelope {
  readonly data: {
    readonly access_token: string;
    readonly token_type: 'Bearer';
    readonly expires_in: number;
  };
  readonly meta: { readonly request_id: string };
}

interface ForgotPasswordEnvelope {
  readonly data: { readonly message: string };
  readonly meta: { readonly request_id: string };
}

function parseBody<T>(
  schema: Parameters<typeof Value.Check>[0],
  body: unknown,
): T {
  if (!Value.Check(schema, body)) {
    throw invalidRequest();
  }
  try {
    return Value.Parse(schema, body) as T;
  } catch (error) {
    throw invalidRequest(error);
  }
}

function requestIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

function parseEmptyBody(body: unknown): void {
  parseBody(EmptyAuthRequestSchema, body === undefined ? {} : body);
}

/** Sets the refresh cookie and returns the envelope every session-issuing route shares. */
function sessionEnvelope(
  request: FastifyRequest,
  reply: FastifyReply,
  session: IssuedSession,
): LoginEnvelope {
  reply.setCookie(
    REFRESH_COOKIE_NAME,
    session.refreshToken,
    REFRESH_COOKIE_OPTIONS,
  );
  return {
    data: {
      access_token: session.accessToken,
      token_type: 'Bearer',
      expires_in: session.expiresIn,
    },
    meta: { request_id: String(request.id) },
  };
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.setCookie(REFRESH_COOKIE_NAME, '', REFRESH_COOKIE_CLEAR_OPTIONS);
}

function isInvalidRefreshToken(error: unknown): boolean {
  return (
    error instanceof AppError && error.code === 'AUTH_REFRESH_TOKEN_INVALID'
  );
}

@Controller('/v1/auth')
export class LocalAuthController {
  constructor(
    @Inject(LOCAL_AUTH_SERVICE)
    private readonly service: LocalAuthServicePort,
  ) {}

  @Post('register')
  @HttpCode(201)
  async register(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<RegisterEnvelope> {
    const input = parseBody<RegisterRequest>(RegisterRequestSchema, body);
    const result = await this.service.register(
      input,
      requestIp(request),
      input.browser_binding,
    );
    return {
      data: result,
      meta: { request_id: String(request.id) },
    };
  }

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async login(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginEnvelope> {
    const input = parseBody<LoginRequest>(LoginRequestSchema, body);
    const result = await this.service.login(input, requestIp(request));
    return sessionEnvelope(request, reply, result);
  }

  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async refresh(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginEnvelope> {
    parseEmptyBody(body);
    const rawToken = hasAlternateRefreshSource(request)
      ? undefined
      : refreshCookieFrom(request);

    try {
      const result = await this.service.refresh(rawToken, requestIp(request));
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

  @Post('logout')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async logout(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    parseEmptyBody(body);
    const rawToken = hasAlternateRefreshSource(request)
      ? undefined
      : refreshCookieFrom(request);
    await this.service.logout(rawToken);
    clearRefreshCookie(reply);
  }

  @Post('verify-email')
  @Header('Cache-Control', 'no-store')
  async verify(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginEnvelope | undefined> {
    const input = parseBody<VerifyEmailRequest>(VerifyEmailRequestSchema, body);
    const session = await this.service.verify(
      input.token,
      requestIp(request),
      input.browser_binding,
    );
    if (session === undefined) {
      reply.status(204);
      return undefined;
    }

    // Verification Sign-in (ADR-0054): the same session a login returns.
    reply.status(200);
    return sessionEnvelope(request, reply, session);
  }

  @Post('resend-verification')
  @HttpCode(202)
  async resend(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<void> {
    const input = parseBody<ResendVerificationRequest>(
      ResendVerificationRequestSchema,
      body,
    );
    await this.service.resend(
      input.email,
      requestIp(request),
      input.browser_binding,
    );
  }

  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ForgotPasswordEnvelope> {
    const input = parseBody<ForgotPasswordRequest>(
      ForgotPasswordRequestSchema,
      body,
    );
    const result = await this.service.forgotPassword(input, requestIp(request));
    return {
      data: result,
      meta: { request_id: String(request.id) },
    };
  }

  @Post('reset-password')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async resetPassword(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const input = parseBody<ResetPasswordRequest>(
      ResetPasswordRequestSchema,
      body,
    );
    await this.service.resetPassword(input, requestIp(request));
    clearRefreshCookie(reply);
  }
}
