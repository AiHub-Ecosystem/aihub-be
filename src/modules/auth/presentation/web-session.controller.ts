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
import { parseRequestBody } from '@/common/http/parse-request-body';
import type { LoginResponse } from '@/contracts/auth/local-auth';
import {
  type CreateWebSessionFromVerificationRequest,
  CreateWebSessionFromVerificationRequestSchema,
  type CreateWebSessionRequest,
  CreateWebSessionRequestSchema,
  type CreateWebSessionResponse,
  type CreateWebSessionResultResponse,
  type ExchangeWebSessionRequest,
  ExchangeWebSessionRequestSchema,
  type LogoutWebSessionRequest,
  LogoutWebSessionRequestSchema,
} from '@/contracts/auth/web-session';
import { webSessionUnavailable } from '@/modules/auth/web-sessions/application/web-session-errors';
import {
  WEB_SESSION_SERVICE,
  type WebSessionServicePort,
} from '@/modules/auth/web-sessions/application/web-session-service.port';
import { accessTokenEnvelope } from './access-token-envelope';
import { WebSessionClientGuard } from './web-session-client.guard';
import {
  endUserIpFrom,
  hasAlternateWebSessionSource,
} from './web-session-transport';

/** The one envelope both creation routes answer, so a BFF reads them alike. */
function createdWebSession(
  request: FastifyRequest,
  created: { readonly token: string; readonly expiresAt: Date },
): CreateWebSessionResponse {
  return {
    data: {
      web_session_token: created.token,
      expires_at: created.expiresAt.toISOString(),
    },
    meta: { request_id: String(request.id) },
  };
}

/**
 * The Customer Web BFF route group: server-to-server only, never a browser.
 *
 * Every route declares its `no-store` policy in the public route catalog.
 * None sets a cookie: the token travels in the JSON body and the BFF stores it
 * in its own HttpOnly cookie on the AIHUB host's
 * behalf, where no `Set-Cookie` for another host would reach.
 */
@Controller()
@UseGuards(WebSessionClientGuard)
export class WebSessionController {
  constructor(
    @Inject(WEB_SESSION_SERVICE)
    private readonly service: WebSessionServicePort,
  ) {}

  @Post(PUBLIC_ROUTES['auth.web_sessions.create'].path)
  @HttpCode(PUBLIC_ROUTES['auth.web_sessions.create'].successStatus)
  async createWebSession(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CreateWebSessionResultResponse> {
    const input: CreateWebSessionRequest = parseRequestBody(
      CreateWebSessionRequestSchema,
      body,
      request,
    );
    const endUserIp = endUserIpFrom(request);
    if (endUserIp === undefined) {
      throw webSessionUnavailable(
        new Error('Customer Web BFF omitted or malformed X-AIHUB-End-User-IP'),
      );
    }

    const result = await this.service.createWebSession(input, endUserIp);

    if (result.kind === 'mfa-required') {
      reply.status(202);
      return {
        data: { status: 'MFA_REQUIRED' },
        meta: { request_id: String(request.id) },
      };
    }
    return createdWebSession(request, result.session);
  }

  // No `@HttpCode`: the status is the request's answer, not a fixed success
  // status. A granted sign-in answers 201 with the session in the body, and one
  // that only verified answers the bodyless 204 the browser-facing verify route
  // answers, so the registry's primary success status alone would be a lie.
  @Post(PUBLIC_ROUTES['auth.web_sessions.verification'].path)
  async createWebSessionFromVerification(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CreateWebSessionResponse | undefined> {
    const input: CreateWebSessionFromVerificationRequest = parseRequestBody(
      CreateWebSessionFromVerificationRequestSchema,
      body,
      request,
    );

    const created = await this.service.createWebSessionFromVerification({
      token: input.token,
      browserBinding: input.browser_binding,
      password: input.password,
    });

    // A binding that does not match still verified the email. The BFF signs the
    // user in here or not at all, and learns which from the status alone.
    if (created === undefined) {
      reply.status(204);
      return undefined;
    }

    reply.status(201);
    return createdWebSession(request, created);
  }

  @Post(PUBLIC_ROUTES['auth.web_sessions.exchange'].path)
  @HttpCode(PUBLIC_ROUTES['auth.web_sessions.exchange'].successStatus)
  async exchangeWebSession(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<LoginResponse> {
    const input: ExchangeWebSessionRequest = parseRequestBody(
      ExchangeWebSessionRequestSchema,
      body,
      request,
    );

    const exchanged = await this.service.exchangeWebSession(
      // The credential belongs in this body and nowhere else, so a token
      // offered in a cookie, an authorization header, or a query parameter is
      // not quietly honoured: it is read from nowhere, which is the same
      // generic session failure as any other unusable session.
      {
        token: hasAlternateWebSessionSource(request)
          ? undefined
          : input.web_session_token,
      },
      endUserIpFrom(request),
    );

    // The envelope login answers, field for field: an integrator already parses
    // one, and a BFF caching this JWT in process needs no new shape.
    return accessTokenEnvelope(
      exchanged.token,
      exchanged.expiresIn,
      String(request.id),
    );
  }

  /**
   * End the one Web Session the caller presented.
   *
   * This route is idempotent on purpose, so it answers one bodyless `204` for a
   * valid session, an already-revoked one, an unknown one, an expired one, and a
   * malformed one alike: a BFF that logs out from a stale tab, or twice, must
   * never see a confusing error, and a caller must not be able to probe which
   * sessions exist. There is no "log out all devices" route — a password reset
   * is what ends every session of an account.
   */
  @Post(PUBLIC_ROUTES['auth.web_sessions.logout'].path)
  @HttpCode(PUBLIC_ROUTES['auth.web_sessions.logout'].successStatus)
  async logoutWebSession(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<void> {
    const input: LogoutWebSessionRequest = parseRequestBody(
      LogoutWebSessionRequestSchema,
      body,
      request,
    );

    await this.service.revokeWebSession(
      // The credential belongs in this body and nowhere else, exactly as on the
      // exchange: a token offered in a cookie, an authorization header, or a
      // query parameter is read from nowhere, which revokes nothing and answers
      // the same `204` as a token AIHUB has never seen.
      {
        token: hasAlternateWebSessionSource(request)
          ? undefined
          : input.web_session_token,
      },
    );
  }
}
