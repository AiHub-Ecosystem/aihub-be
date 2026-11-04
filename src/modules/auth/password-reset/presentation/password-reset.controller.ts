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
  ForgotPasswordRequestSchema,
  ResetPasswordRequestSchema,
} from '@/contracts/auth/local-auth';
import {
  PASSWORD_RECOVERY,
  type PasswordRecoveryPort,
} from '@/modules/auth/local-credentials/application/password-recovery.port';
import { requestIp } from '@/modules/auth/shared/presentation/auth-request';
import { clearRefreshCookie } from '@/modules/auth/shared/presentation/session-transport';

interface ForgotPasswordEnvelope {
  readonly data: { readonly message: string };
  readonly meta: { readonly request_id: string };
}

@Controller()
export class PasswordResetController {
  constructor(
    @Inject(PASSWORD_RECOVERY)
    private readonly recovery: PasswordRecoveryPort,
  ) {}

  @Post(PUBLIC_ROUTES['auth.forgot_password'].path)
  @HttpCode(PUBLIC_ROUTES['auth.forgot_password'].successStatus)
  async forgotPassword(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ForgotPasswordEnvelope> {
    const input = parseRequestBody(ForgotPasswordRequestSchema, body, request);
    const result = await this.recovery.forgotPassword(
      input,
      requestIp(request),
    );
    return {
      data: result,
      meta: { request_id: String(request.id) },
    };
  }

  @Post(PUBLIC_ROUTES['auth.reset_password'].path)
  @HttpCode(PUBLIC_ROUTES['auth.reset_password'].successStatus)
  async resetPassword(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const input = parseRequestBody(ResetPasswordRequestSchema, body, request);
    await this.recovery.resetPassword(input, requestIp(request));
    clearRefreshCookie(reply);
  }
}
