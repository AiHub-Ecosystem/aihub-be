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

import { invalidRequest } from '../../../common/errors/invalid-request';
import {
  type LoginRequest,
  LoginRequestSchema,
  type RegisterRequest,
  RegisterRequestSchema,
  type ResendVerificationRequest,
  ResendVerificationRequestSchema,
  type VerifyEmailRequest,
  VerifyEmailRequestSchema,
} from '../../../contracts/auth/local-auth';
import {
  LOCAL_AUTH_SERVICE,
  type LocalAuthServicePort,
} from '../application/local-auth-service.port';

interface RegisterEnvelope {
  readonly data: {
    readonly email: string;
    readonly username: string;
    readonly status: 'pending_verification';
  };
  readonly meta: { readonly request_id: string };
}

interface LoginEnvelope {
  readonly data: {
    readonly access_token: string;
    readonly token_type: 'Bearer';
    readonly expires_in: number;
  };
  readonly meta: { readonly request_id: string };
}

function parseBody<T>(
  schema: Parameters<typeof Value.Check>[0],
  body: unknown,
): T {
  if (!Value.Check(schema, body)) {
    throw invalidRequest();
  }
  try {
    return Value.Parse(schema, body) as T;
  } catch (error) {
    throw invalidRequest(error);
  }
}

function requestIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

@Controller('/v1/auth')
export class LocalAuthController {
  constructor(
    @Inject(LOCAL_AUTH_SERVICE)
    private readonly service: LocalAuthServicePort,
  ) {}

  @Post('register')
  @HttpCode(201)
  async register(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<RegisterEnvelope> {
    const input = parseBody<RegisterRequest>(RegisterRequestSchema, body);
    const result = await this.service.register(input, requestIp(request));
    return {
      data: result,
      meta: { request_id: String(request.id) },
    };
  }

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async login(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<LoginEnvelope> {
    const input = parseBody<LoginRequest>(LoginRequestSchema, body);
    const result = await this.service.login(input, requestIp(request));
    return {
      data: {
        access_token: result.accessToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
      },
      meta: { request_id: String(request.id) },
    };
  }

  @Post('verify-email')
  @HttpCode(204)
  async verify(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<void> {
    const input = parseBody<VerifyEmailRequest>(VerifyEmailRequestSchema, body);
    await this.service.verify(input.token, requestIp(request));
  }

  @Post('resend-verification')
  @HttpCode(202)
  async resend(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<void> {
    const input = parseBody<ResendVerificationRequest>(
      ResendVerificationRequestSchema,
      body,
    );
    await this.service.resend(input.email, requestIp(request));
  }
}
