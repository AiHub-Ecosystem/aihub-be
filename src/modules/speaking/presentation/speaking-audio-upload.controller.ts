import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import type { FastifyReply } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { invalidRequest } from '@/common/errors/invalid-request';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import {
  type CreateSpeakingAudioUploadRequest,
  CreateSpeakingAudioUploadRequestSchema,
  type SpeakingAudioAssetResponse,
  type SpeakingAudioUploadUrlResponse,
} from '@/contracts/speaking/audio-upload';
import { RateLimitGuard } from '@/modules/gateway/presentation/rate-limit.guard';
import { ApiKeyUserIdentityGuard } from '@/modules/identity/api-keys/presentation/api-key-user-identity.guard';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import {
  SPEAKING_AUDIO_UPLOAD_SERVICE,
  type SpeakingAudioUploadGrant,
  type SpeakingAudioUploadServicePort,
} from '@/modules/speaking/application/speaking-audio-upload.port';
import type { SpeakingAudioAsset } from '@/modules/speaking/domain/speaking-audio-asset';

function requestContext(request: AuthenticatedRequest) {
  const authenticated = getAuthenticatedApiKey(request);
  const identity = request.aihubIdentity;
  if (identity === undefined) {
    throw invalidRequest();
  }

  return createRequestContext({
    requestId: String(request.id),
    receivedAt: new Date(),
    deadlineMs: 10_000,
    organizationId: authenticated.organizationId,
    apiKeyId: authenticated.apiKeyId,
    environment: authenticated.environment,
    userId: identity.userId,
    scopes: authenticated.scopes,
  });
}

function uploadResponse(
  requestId: string,
  upload: SpeakingAudioUploadGrant,
): SpeakingAudioUploadUrlResponse {
  return {
    data: {
      asset_id: upload.assetId,
      upload_url: upload.uploadUrl,
      method: 'PUT',
      headers: {
        'Content-Type': upload.contentType,
        'Content-Length': String(upload.byteSize),
      },
      expires_at: upload.uploadUrlExpiresAt.toISOString(),
      intent_expires_at: upload.intentExpiresAt.toISOString(),
    },
    meta: { request_id: requestId },
  };
}

function assetResponse(
  requestId: string,
  asset: SpeakingAudioAsset,
): SpeakingAudioAssetResponse {
  return {
    data: {
      asset_id: asset.assetId,
      content_type: asset.contentType,
      byte_size: asset.byteSize,
      accepted_at: asset.acceptedAt.toISOString(),
      retention_expires_at: asset.retentionExpiresAt.toISOString(),
    },
    meta: { request_id: requestId },
  };
}

@Controller()
@UseGuards(ApiKeyUserIdentityGuard, RateLimitGuard)
export class SpeakingAudioUploadController {
  constructor(
    @Inject(SPEAKING_AUDIO_UPLOAD_SERVICE)
    private readonly uploads: SpeakingAudioUploadServicePort,
  ) {}

  @Post(PUBLIC_ROUTES['speaking.audioUploads.create'].path)
  @HttpCode(PUBLIC_ROUTES['speaking.audioUploads.create'].successStatus)
  @Header('Cache-Control', 'no-store')
  async requestUpload(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<SpeakingAudioUploadUrlResponse> {
    if (!Value.Check(CreateSpeakingAudioUploadRequestSchema, body)) {
      throw invalidRequest();
    }
    let parsed: CreateSpeakingAudioUploadRequest;
    try {
      parsed = Value.Parse(
        CreateSpeakingAudioUploadRequestSchema,
        body,
      ) as CreateSpeakingAudioUploadRequest;
    } catch {
      throw invalidRequest();
    }

    const upload = await this.uploads.requestUpload({
      context: requestContext(request),
      contentType: parsed.content_type,
      byteSize: parsed.byte_size,
    });
    return uploadResponse(String(request.id), upload);
  }

  @Post(PUBLIC_ROUTES['speaking.audioUploads.refresh'].path)
  @HttpCode(PUBLIC_ROUTES['speaking.audioUploads.refresh'].successStatus)
  @Header('Cache-Control', 'no-store')
  async refreshUpload(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
  ): Promise<SpeakingAudioUploadUrlResponse> {
    const upload = await this.uploads.refreshUpload({
      context: requestContext(request),
      assetId,
    });
    return uploadResponse(String(request.id), upload);
  }

  @Post(PUBLIC_ROUTES['speaking.audioUploads.complete'].path)
  @HttpCode(PUBLIC_ROUTES['speaking.audioUploads.complete'].successStatus)
  @Header('Cache-Control', 'no-store')
  async completeUpload(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SpeakingAudioAssetResponse> {
    const completed = await this.uploads.completeUpload({
      context: requestContext(request),
      assetId,
    });
    if (!completed.created) {
      reply.status(200);
    }
    return assetResponse(String(request.id), completed.asset);
  }
}
