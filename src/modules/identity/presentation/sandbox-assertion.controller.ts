import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';

import { AppError } from '../../../common/errors/app-error';
import {
  type MintSandboxAssertionRequest,
  MintSandboxAssertionRequestSchema,
  type MintSandboxAssertionResponse,
} from '../../../contracts/sandbox/assertion';
import {
  SANDBOX_ASSERTION_MINTER,
  type SandboxAssertionMinterPort,
} from '../application/sandbox-assertion-minter.port';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from './authenticated-request';
import { SandboxApiKeyGuard } from './sandbox-api-key.guard';

function invalidRequest(cause?: unknown): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message: 'Request failed validation',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

function parseBody(body: unknown): MintSandboxAssertionRequest {
  if (!Value.Check(MintSandboxAssertionRequestSchema, body)) {
    throw invalidRequest();
  }

  try {
    return Value.Parse(MintSandboxAssertionRequestSchema, body);
  } catch (error) {
    throw invalidRequest(error);
  }
}

/**
 * Issues a short-lived user assertion for a sandbox organization, so that
 * testing the gateway does not require holding an organization's signing key.
 *
 * The response deliberately skips the dispatch envelope the proxy operations
 * return. That envelope reports downstream and gateway timings for a call that
 * reached an AI service; this request reaches none, and reporting zeroed
 * downstream timings would be a fiction.
 */
@Controller()
@UseGuards(SandboxApiKeyGuard)
export class SandboxAssertionController {
  private readonly logger = new Logger(SandboxAssertionController.name);

  constructor(
    @Inject(SANDBOX_ASSERTION_MINTER)
    private readonly minter: SandboxAssertionMinterPort,
  ) {}

  @Post('/v1/sandbox/assertions')
  @HttpCode(200)
  async mint(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<MintSandboxAssertionResponse> {
    const parsed = parseBody(body);
    const authenticated = getAuthenticatedApiKey(request);
    const minted = await this.minter.mint({
      organizationId: authenticated.organizationId,
      userId: parsed.user_id,
    });

    // Identifies who minted what, without the assertion itself: the token is a
    // credential, and one in a log file outlives the request that made it.
    this.logger.log(
      JSON.stringify({
        event: 'sandbox_assertion_minted',
        organizationId: authenticated.organizationId,
        apiKeyId: authenticated.apiKeyId,
        userId: minted.userId,
        jti: minted.jti,
        expiresAt: minted.expiresAt,
      }),
    );

    return {
      assertion: minted.assertion,
      user_id: minted.userId,
      expires_at: minted.expiresAt,
    };
  }
}
