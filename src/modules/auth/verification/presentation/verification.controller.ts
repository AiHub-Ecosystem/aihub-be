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
import { parseRequestBody } from '@/common/http/parse-request-body';
import {
  type LoginResponse,
  type ResendVerificationRequest,
  ResendVerificationRequestSchema,
  type VerifyEmailRequest,
  VerifyEmailRequestSchema,
} from '@/contracts/auth/local-auth';
import {
  LOCAL_REGISTRATION,
  type LocalRegistrationPort,
} from '@/modules/auth/local-credentials/application/local-registration.port';
import { requestIp } from '@/modules/auth/shared/presentation/auth-request';
import { sessionEnvelope } from '@/modules/auth/shared/presentation/session-transport';

@Controller()
export class VerificationController {
  constructor(
    @Inject(LOCAL_REGISTRATION)
    private readonly registration: LocalRegistrationPort,
  ) {}

  // No `@HttpCode`: the status is the request's answer, not a fixed success
  // status. Verification Sign-in returns 200, a verify without a binding
  // returns 204, so the registry's primary success status would be a lie here.
  @Post(PUBLIC_ROUTES['auth.verify_email'].path)
  async verify(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse | undefined> {
    const input: VerifyEmailRequest = parseRequestBody(
      VerifyEmailRequestSchema,
      body,
      request,
    );
    const session = await this.registration.verify(
      input.token,
      requestIp(request),
      input.browser_binding,
      input.password,
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
      request,
    );
    await this.registration.resend(
      input.email,
      requestIp(request),
      input.browser_binding,
    );
  }
}
