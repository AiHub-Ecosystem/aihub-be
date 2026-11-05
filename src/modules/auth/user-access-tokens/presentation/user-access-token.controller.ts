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
  type RevokeUserAccessTokenRequest,
  RevokeUserAccessTokenRequestSchema,
} from '@/contracts/auth/user-access-token';
import { authenticatedUserId } from '@/modules/auth/shared/presentation/auth-request';
import {
  REVOKE_USER_ACCESS_TOKEN,
  type RevokeUserAccessTokenPort,
} from '@/modules/auth/user-access-tokens/application/revoke-user-access-token.port';
import { UserAccessJwtGuard } from '@/modules/auth/web-sessions/public';

@Controller()
export class UserAccessTokenController {
  constructor(
    @Inject(REVOKE_USER_ACCESS_TOKEN)
    private readonly revokeToken: RevokeUserAccessTokenPort,
  ) {}

  @Post(PUBLIC_ROUTES['auth.user_access_tokens.revoke'].path)
  @UseGuards(UserAccessJwtGuard)
  @HttpCode(PUBLIC_ROUTES['auth.user_access_tokens.revoke'].successStatus)
  async revoke(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<void> {
    const input: RevokeUserAccessTokenRequest = parseRequestBody(
      RevokeUserAccessTokenRequestSchema,
      body,
      request,
    );
    await this.revokeToken.revoke({
      callerUserId: authenticatedUserId(request),
      token: input.token,
    });
  }
}
