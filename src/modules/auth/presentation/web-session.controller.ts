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

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { invalidRequest } from '@/common/errors/invalid-request';
import {
  type CreateWebSessionFromVerificationRequest,
  CreateWebSessionFromVerificationRequestSchema,
  type CreateWebSessionRequest,
  CreateWebSessionRequestSchema,
  type CreateWebSessionResponse,
} from '@/contracts/auth/web-session';
import {
  WEB_SESSION_SERVICE,
  type WebSessionServicePort,
} from '@/modules/auth/application/web-session.service';
import { clientSecretFrom } from '@/modules/auth/presentation/refresh-cookie';

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
 * Every route here answers `Cache-Control: no-store` — declared with
 * `@Header`, which Nest applies to the response it builds whatever status the
 * request ends with. None of them sets a cookie: the token travels in the JSON
 * body and the BFF stores it in its own HttpOnly cookie on the AIHUB host's
 * behalf, where no `Set-Cookie` for another host would reach.
 */
@Controller()
export class WebSessionController {
  constructor(
    @Inject(WEB_SESSION_SERVICE)
    private readonly service: WebSessionServicePort,
  ) {}

  @Post(PUBLIC_ROUTES['auth.web_sessions.create'].path)
  @HttpCode(PUBLIC_ROUTES['auth.web_sessions.create'].successStatus)
  @Header('Cache-Control', 'no-store')
  async createWebSession(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<CreateWebSessionResponse> {
    if (!Value.Check(CreateWebSessionRequestSchema, body)) {
      throw invalidRequest();
    }
    const input = Value.Parse(
      CreateWebSessionRequestSchema,
      body,
    ) as CreateWebSessionRequest;

    const created = await this.service.createWebSession(
      input,
      request.ip || 'unknown',
      clientSecretFrom(request),
    );

    return createdWebSession(request, created);
  }

  // No `@HttpCode`: the status is the request's answer, not a fixed success
  // status. A granted sign-in answers 201 with the session in the body, and one
  // that only verified answers the bodyless 204 the browser-facing verify route
  // answers, so the registry's primary success status alone would be a lie.
  @Post(PUBLIC_ROUTES['auth.web_sessions.verification'].path)
  @Header('Cache-Control', 'no-store')
  async createWebSessionFromVerification(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CreateWebSessionResponse | undefined> {
    if (!Value.Check(CreateWebSessionFromVerificationRequestSchema, body)) {
      throw invalidRequest();
    }
    const input = Value.Parse(
      CreateWebSessionFromVerificationRequestSchema,
      body,
    ) as CreateWebSessionFromVerificationRequest;

    const created = await this.service.createWebSessionFromVerification(
      { token: input.token, browserBinding: input.browser_binding },
      request.ip || 'unknown',
      clientSecretFrom(request),
    );

    // A binding that does not match still verified the email. The BFF signs the
    // user in here or not at all, and learns which from the status alone.
    if (created === undefined) {
      reply.status(204);
      return undefined;
    }

    reply.status(201);
    return createdWebSession(request, created);
  }
}
