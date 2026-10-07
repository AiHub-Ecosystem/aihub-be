import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import type { FastifyRequest } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { invalidRequest } from '@/common/errors/invalid-request';
import {
  type CreateWebSessionRequest,
  CreateWebSessionRequestSchema,
  type CreateWebSessionResponse,
} from '@/contracts/auth/web-session';
import {
  WEB_SESSION_SERVICE,
  type WebSessionServicePort,
} from '@/modules/auth/application/web-session.service';
import { clientSecretFrom } from '@/modules/auth/presentation/refresh-cookie';

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

    return {
      data: {
        web_session_token: created.token,
        expires_at: created.expiresAt.toISOString(),
      },
      meta: { request_id: String(request.id) },
    };
  }
}
