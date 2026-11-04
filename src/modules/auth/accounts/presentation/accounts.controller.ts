import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import type { ReadCurrentUserResponse } from '@/contracts/auth/local-auth';
import {
  LOCAL_SESSION,
  type LocalSessionPort,
} from '@/modules/auth/local-credentials/application/local-session.port';
import { authenticatedUserId } from '@/modules/auth/shared/presentation/auth-request';
import { UserAccessJwtGuard } from '@/modules/auth/web-sessions/public';

@Controller()
export class AccountsController {
  constructor(
    @Inject(LOCAL_SESSION)
    private readonly sessions: LocalSessionPort,
  ) {}

  @Get(PUBLIC_ROUTES['me.profile.read'].path)
  @UseGuards(UserAccessJwtGuard)
  @HttpCode(PUBLIC_ROUTES['me.profile.read'].successStatus)
  async currentUser(
    @Req() request: FastifyRequest,
  ): Promise<ReadCurrentUserResponse> {
    const profile = await this.sessions.currentUser(
      authenticatedUserId(request),
    );
    return {
      data: profile,
      meta: { request_id: String(request.id) },
    };
  }
}
