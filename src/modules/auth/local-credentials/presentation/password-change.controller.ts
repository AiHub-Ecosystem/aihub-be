import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { parseRequestBody } from '@/common/http/parse-request-body';
import {
  type ChangePasswordRequest,
  ChangePasswordRequestSchema,
} from '@/contracts/auth/local-auth';
import {
  PASSWORD_CHANGE,
  type PasswordChangePort,
} from '@/modules/auth/local-credentials/application/password-change.port';
import {
  authenticatedUserId,
  requestIp,
} from '@/modules/auth/shared/presentation/auth-request';
import { UserAccessJwtGuard } from '@/modules/auth/web-sessions/public';

@Controller()
export class PasswordChangeController {
  constructor(
    @Inject(PASSWORD_CHANGE)
    private readonly passwordChange: PasswordChangePort,
  ) {}

  @Post(PUBLIC_ROUTES['auth.change_password'].path)
  @UseGuards(UserAccessJwtGuard)
  @HttpCode(PUBLIC_ROUTES['auth.change_password'].successStatus)
  async changePassword(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<void> {
    const input: ChangePasswordRequest = parseRequestBody(
      ChangePasswordRequestSchema,
      body,
      request,
    );
    await this.passwordChange.change({
      userId: authenticatedUserId(request),
      session: request.aihubUser?.session,
      currentPassword: input.current_password,
      newPassword: input.new_password,
      ip: requestIp(request),
    });
  }
}
