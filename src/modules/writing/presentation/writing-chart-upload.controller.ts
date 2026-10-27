import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { parseRequestBody } from '@/common/http/parse-request-body';
import { getRequestLifecycle } from '@/common/http/request-lifecycle.hook';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import {
  type CreateWritingChartUploadRequest,
  CreateWritingChartUploadRequestSchema,
  type WritingChartAssetResponse,
  type WritingChartUploadGrantResponse,
} from '@/contracts/writing/chart-upload';
import { RateLimitGuard } from '@/modules/gateway/presentation/rate-limit.guard';
import { ApiKeyGuard } from '@/modules/identity/api-keys/presentation/api-key.guard';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import { RequireOperation } from '@/modules/identity/shared/presentation/require-operation.decorator';
import { UserIdentityGuard } from '@/modules/identity/shared/presentation/user-identity.guard';
import {
  WRITING_CHART_UPLOAD_SERVICE,
  type WritingChartUploadServicePort,
} from '@/modules/writing/application/writing-chart-upload.port';
import type { WritingChartAsset } from '@/modules/writing/domain/writing-chart-upload';

const OPERATION = 'writing.task1.grade' as const;

function requestContext(request: AuthenticatedRequest) {
  const authenticated = request.aihubAuth;
  const identity = request.aihubIdentity;
  if (authenticated === undefined || identity === undefined) {
    throw new Error('writing chart upload identity is missing');
  }
  const lifecycle = getRequestLifecycle(request.raw);
  return createRequestContext({
    requestId: String(request.id),
    receivedAt: lifecycle?.receivedAt ?? new Date(),
    ...(lifecycle === undefined ? {} : { signal: lifecycle.signal }),
    deadlineMs: PUBLIC_ROUTES['writing.chartUploads.complete'].timeoutMs,
    organizationId: authenticated.organizationId,
    apiKeyId: authenticated.apiKeyId,
    environment: authenticated.environment,
    userId: identity.userId,
    scopes: authenticated.scopes,
  });
}

function uploadResponse(
  requestId: string,
  upload: Awaited<ReturnType<WritingChartUploadServicePort['create']>>,
): WritingChartUploadGrantResponse {
  return {
    data: {
      asset_id: upload.assetId,
      upload_url: upload.uploadUrl,
      method: 'POST',
      fields: upload.uploadFields,
      expires_at: upload.uploadUrlExpiresAt.toISOString(),
      intent_expires_at: upload.intentExpiresAt.toISOString(),
    },
    meta: { request_id: requestId },
  };
}

function assetResponse(
  requestId: string,
  asset: WritingChartAsset,
): WritingChartAssetResponse {
  return {
    data: {
      asset_id: asset.assetId,
      image_url: asset.imageUrl,
      content_type: asset.contentType,
      byte_size: asset.byteSize,
      published_at: asset.publishedAt.toISOString(),
      expires_at: asset.retentionExpiresAt.toISOString(),
    },
    meta: { request_id: requestId },
  };
}

@Controller()
@UseGuards(ApiKeyGuard, UserIdentityGuard, RateLimitGuard)
export class WritingChartUploadController {
  constructor(
    @Inject(WRITING_CHART_UPLOAD_SERVICE)
    private readonly uploads: WritingChartUploadServicePort,
  ) {}

  @Post(PUBLIC_ROUTES['writing.chartUploads.create'].path)
  @HttpCode(PUBLIC_ROUTES['writing.chartUploads.create'].successStatus)
  @RequireOperation(OPERATION)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<WritingChartUploadGrantResponse> {
    const parsed: CreateWritingChartUploadRequest = parseRequestBody(
      CreateWritingChartUploadRequestSchema,
      body,
      request,
    );
    return uploadResponse(
      String(request.id),
      await this.uploads.create({
        context: requestContext(request),
        contentType: parsed.content_type,
        byteSize: parsed.byte_size,
      }),
    );
  }

  @Post(PUBLIC_ROUTES['writing.chartUploads.refresh'].path)
  @HttpCode(PUBLIC_ROUTES['writing.chartUploads.refresh'].successStatus)
  @RequireOperation(OPERATION)
  async refresh(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
  ): Promise<WritingChartUploadGrantResponse> {
    return uploadResponse(
      String(request.id),
      await this.uploads.refresh({ context: requestContext(request), assetId }),
    );
  }

  @Post(PUBLIC_ROUTES['writing.chartUploads.complete'].path)
  @HttpCode(PUBLIC_ROUTES['writing.chartUploads.complete'].successStatus)
  @RequireOperation(OPERATION)
  async complete(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
  ): Promise<WritingChartAssetResponse> {
    return assetResponse(
      String(request.id),
      await this.uploads.complete({
        context: requestContext(request),
        assetId,
      }),
    );
  }
}
