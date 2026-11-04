import {
  Body,
  Controller,
  Delete,
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
  BeginMfaEnrollmentRequestSchema,
  type BeginMfaEnrollmentResponse,
  ConfirmMfaEnrollmentRequestSchema,
  type ConfirmMfaEnrollmentResponse,
  RemoveMfaFactorRequestSchema,
} from '@/contracts/auth/mfa';
import {
  AUTH_MFA_SERVICE,
  type AuthMfaServicePort,
} from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import {
  authenticatedUserId,
  credentialIp,
} from '@/modules/auth/shared/presentation/auth-request';
import {
  OptionalWebSessionClientGuard,
  UserAccessJwtGuard,
} from '@/modules/auth/web-sessions/public';

@Controller()
export class MfaController {
  constructor(
    @Inject(AUTH_MFA_SERVICE)
    private readonly mfa: AuthMfaServicePort,
  ) {}

  @Post(PUBLIC_ROUTES['auth.mfa.enrollment'].path)
  @HttpCode(PUBLIC_ROUTES['auth.mfa.enrollment'].successStatus)
  @UseGuards(UserAccessJwtGuard, OptionalWebSessionClientGuard)
  async beginMfaEnrollment(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<BeginMfaEnrollmentResponse> {
    const input = parseRequestBody(
      BeginMfaEnrollmentRequestSchema,
      body,
      request,
    );
    const enrollment = await this.mfa.beginEnrollment({
      userId: authenticatedUserId(request),
      password: input.password,
      ip: credentialIp(request),
    });
    return {
      data: { secret: enrollment.secret, otpauth_uri: enrollment.otpauthUri },
      meta: { request_id: String(request.id) },
    };
  }

  @Post(PUBLIC_ROUTES['auth.mfa.enrollment.confirm'].path)
  @HttpCode(PUBLIC_ROUTES['auth.mfa.enrollment.confirm'].successStatus)
  @UseGuards(UserAccessJwtGuard, OptionalWebSessionClientGuard)
  async confirmMfaEnrollment(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ConfirmMfaEnrollmentResponse> {
    const input = parseRequestBody(
      ConfirmMfaEnrollmentRequestSchema,
      body,
      request,
    );
    const recoveryCodes = await this.mfa.confirmEnrollment({
      userId: authenticatedUserId(request),
      code: input.code,
      ip: credentialIp(request),
    });
    return {
      data: { recovery_codes: [...recoveryCodes] },
      meta: { request_id: String(request.id) },
    };
  }

  @Delete(PUBLIC_ROUTES['auth.mfa.remove'].path)
  @HttpCode(PUBLIC_ROUTES['auth.mfa.remove'].successStatus)
  @UseGuards(UserAccessJwtGuard, OptionalWebSessionClientGuard)
  async removeMfaFactor(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<void> {
    const proof = parseRequestBody(RemoveMfaFactorRequestSchema, body, request);
    await this.mfa.removeFactor({
      userId: authenticatedUserId(request),
      proof,
      ip: credentialIp(request),
    });
  }
}
