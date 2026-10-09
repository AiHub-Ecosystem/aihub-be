import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { AppError } from '@/common/errors/app-error';
import { parseRequestBody } from '@/common/http/parse-request-body';
import {
  EmptyAuthRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  type LoginResponse,
  type ReadCurrentUserResponse,
  RegisterRequestSchema,
  type ResendVerificationRequest,
  ResendVerificationRequestSchema,
  ResetPasswordRequestSchema,
  type VerifyEmailRequest,
  VerifyEmailRequestSchema,
} from '@/contracts/auth/local-auth';
import {
  type IssuedSession,
  LOCAL_AUTH_SERVICE,
  type LocalAuthServicePort,
  RefreshRotationCommittedError,
} from '@/modules/auth/application/local-auth-service.port';
import { accessTokenEnvelope } from './access-token-envelope';
import { requestIp } from './auth-request';
import {
  REFRESH_COOKIE_CLEAR_OPTIONS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_OPTIONS,
  hasAlternateRefreshSource,
  refreshCookieFrom,
} from './refresh-cookie';
import { UserAccessJwtGuard } from './user-access-jwt.guard';

interface RegisterEnvelope {
  readonly data: {
    readonly email: string;
    readonly username: string;
    readonly status: 'pending_verification';
    readonly email_delivery_status: 'queued';
  };
  readonly meta: { readonly request_id: string };
}

interface ForgotPasswordEnvelope {
  readonly data: { readonly message: string };
  readonly meta: { readonly request_id: string };
}

function parseEmptyBody(body: unknown): void {
  parseRequestBody(EmptyAuthRequestSchema, body);
}

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.aihubUser?.userId;
  if (userId === undefined) {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Authenticated user context is missing',
      retryable: false,
    });
  }
  return userId;
}

/** Sets the refresh cookie and returns the envelope every session-issuing route shares. */
function sessionEnvelope(
  request: FastifyRequest,
  reply: FastifyReply,
  session: IssuedSession,
): LoginResponse {
  reply.setCookie(
    REFRESH_COOKIE_NAME,
    session.refreshToken,
    REFRESH_COOKIE_OPTIONS,
  );
  return accessTokenEnvelope(
    session.accessToken,
    session.expiresIn,
    String(request.id),
  );
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.setCookie(REFRESH_COOKIE_NAME, '', REFRESH_COOKIE_CLEAR_OPTIONS);
}

function isInvalidRefreshToken(error: unknown): boolean {
  return (
    error instanceof AppError && error.code === 'AUTH_REFRESH_TOKEN_INVALID'
  );
}

@Controller()
export class LocalAuthController {
  constructor(
    @Inject(LOCAL_AUTH_SERVICE)
    private readonly service: LocalAuthServicePort,
  ) {}

  @Get(PUBLIC_ROUTES['me.profile.read'].path)
  @UseGuards(UserAccessJwtGuard)
  @HttpCode(PUBLIC_ROUTES['me.profile.read'].successStatus)
  @Header('Cache-Control', 'no-store')
  async currentUser(
    @Req() request: FastifyRequest,
  ): Promise<ReadCurrentUserResponse> {
    const profile = await this.service.currentUser(
      authenticatedUserId(request),
    );
    return {
      data: profile,
      meta: { request_id: String(request.id) },
    };
  }

  @Post(PUBLIC_ROUTES['auth.register'].path)
  @HttpCode(PUBLIC_ROUTES['auth.register'].successStatus)
  async register(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<RegisterEnvelope> {
    const input = parseRequestBody(RegisterRequestSchema, body);
    const result = await this.service.register(
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
  @Header('Cache-Control', 'no-store')
  async login(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
    const input = parseRequestBody(LoginRequestSchema, body);
    const result = await this.service.login(input, requestIp(request));
    return sessionEnvelope(request, reply, result);
  }

  @Post(PUBLIC_ROUTES['auth.refresh'].path)
  @HttpCode(PUBLIC_ROUTES['auth.refresh'].successStatus)
  @Header('Cache-Control', 'no-store')
  async refresh(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
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

  @Post(PUBLIC_ROUTES['auth.logout'].path)
  @HttpCode(PUBLIC_ROUTES['auth.logout'].successStatus)
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

  // No `@HttpCode`: the status is the request's answer, not a fixed success
  // status. Verification Sign-in returns 200, a verify without a binding
  // returns 204, so the registry's primary success status would be a lie here.
  @Post(PUBLIC_ROUTES['auth.verify_email'].path)
  @Header('Cache-Control', 'no-store')
  async verify(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse | undefined> {
    const input: VerifyEmailRequest = parseRequestBody(
      VerifyEmailRequestSchema,
      body,
    );
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

  @Post(PUBLIC_ROUTES['auth.resend_verification'].path)
  @HttpCode(PUBLIC_ROUTES['auth.resend_verification'].successStatus)
  async resend(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<void> {
    const input: ResendVerificationRequest = parseRequestBody(
      ResendVerificationRequestSchema,
      body,
    );
    await this.service.resend(
      input.email,
      requestIp(request),
      input.browser_binding,
    );
  }

  @Post(PUBLIC_ROUTES['auth.forgot_password'].path)
  @HttpCode(PUBLIC_ROUTES['auth.forgot_password'].successStatus)
  async forgotPassword(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ForgotPasswordEnvelope> {
    const input = parseRequestBody(ForgotPasswordRequestSchema, body);
    const result = await this.service.forgotPassword(input, requestIp(request));
    return {
      data: result,
      meta: { request_id: String(request.id) },
    };
  }

  @Post(PUBLIC_ROUTES['auth.reset_password'].path)
  @HttpCode(PUBLIC_ROUTES['auth.reset_password'].successStatus)
  @Header('Cache-Control', 'no-store')
  async resetPassword(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const input = parseRequestBody(ResetPasswordRequestSchema, body);
    await this.service.resetPassword(input, requestIp(request));
    clearRefreshCookie(reply);
  }
}
