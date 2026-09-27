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

import { PUBLIC_ROUTES } from '../../../catalog/public-routes';
import { invalidRequest } from '../../../common/errors/invalid-request';
import { createRequestContext } from '../../../common/request-context/request-context.factory';
import { isRequestId } from '../../../common/request-context/request-id';
import {
  type MintSandboxAssertionRequest,
  MintSandboxAssertionRequestSchema,
  type MintSandboxAssertionResponse,
} from '../../../contracts/sandbox/assertion';
import { RateLimitGuard } from '../../gateway/presentation/rate-limit.guard';
import {
  SANDBOX_ASSERTION_MINTER,
  type SandboxAssertionMinterPort,
} from '../application/sandbox-assertion-minter.port';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from './authenticated-request';
import { SandboxApiKeyGuard } from './sandbox-api-key.guard';

/**
 * No downstream call, no key import beyond the first: a mint is bounded by one
 * signature. The deadline exists so the context is well-formed and so a
 * pathological stall cannot hold the request open indefinitely.
 */
const MINT_DEADLINE_MS = 5_000;

interface MintEnvelope {
  readonly data: MintSandboxAssertionResponse;
  readonly meta: { readonly request_id: string };
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
 * `RateLimitGuard` applies as it does to every other authenticated route:
 * minting is cheap, but an allowlisted key that can mint without bound is a
 * key that can fill a log and a downstream quota at machine speed. There is no
 * `ConcurrencyGuard`, which exists to cap simultaneous *downstream* work; this
 * route reaches no downstream and holds no permit worth releasing.
 */
@Controller()
@UseGuards(SandboxApiKeyGuard, RateLimitGuard)
export class SandboxAssertionController {
  private readonly logger = new Logger(SandboxAssertionController.name);

  constructor(
    @Inject(SANDBOX_ASSERTION_MINTER)
    private readonly minter: SandboxAssertionMinterPort,
  ) {}

  @Post(PUBLIC_ROUTES['sandbox.assertions.mint'].path)
  @HttpCode(PUBLIC_ROUTES['sandbox.assertions.mint'].successStatus)
  async mint(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<MintEnvelope> {
    const parsed = parseBody(body);
    const authenticated = getAuthenticatedApiKey(request);
    const requestId = isRequestId(request.id) ? request.id : String(request.id);
    const context = createRequestContext({
      requestId,
      receivedAt: new Date(),
      deadlineMs: MINT_DEADLINE_MS,
      organizationId: authenticated.organizationId,
      apiKeyId: authenticated.apiKeyId,
      scopes: authenticated.scopes,
    });

    const minted = await this.minter.mint({ context, userId: parsed.user_id });

    // Identifies who minted what, without the assertion itself: the token is a
    // credential, and one in a log file outlives the request that made it. The
    // request id is what joins this line to the rest of the request's trail.
    this.logger.log(
      JSON.stringify({
        event: 'sandbox_assertion_minted',
        requestId: context.requestId,
        organizationId: authenticated.organizationId,
        apiKeyId: authenticated.apiKeyId,
        userId: minted.userId,
        jti: minted.jti,
        expiresAt: minted.expiresAt,
      }),
    );

    // The proxy operations report downstream and gateway timings for a call
    // that reached an AI service. This one reaches none, and zeroed downstream
    // timings would be a fiction — but the request id is not, and a caller
    // reporting a problem needs it as much here as anywhere else.
    return {
      data: {
        assertion: minted.assertion,
        user_id: minted.userId,
        expires_at: minted.expiresAt,
      },
      meta: { request_id: requestId },
    };
  }
}
