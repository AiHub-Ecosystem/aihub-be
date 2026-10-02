import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import {
  type AvatarResponse,
  type AvatarUploadResponse,
  CreateAvatarUploadRequestSchema,
  type ReadAvatarResponse,
} from '@/contracts/avatar/avatar';
import { UserAccessJwtGuard } from '@/modules/auth/presentation/user-access-jwt.guard';
import {
  AvatarUploadService,
  type PublishedAvatar,
} from '@/modules/avatar/application/avatar-upload.service';
import { AVATAR_CACHE_CONTROL } from '@/modules/avatar/domain/avatar';

function authenticatedUser(request: FastifyRequest): {
  readonly userId: string;
  readonly requestId: string;
} {
  const userId = request.aihubUser?.userId;
  if (userId === undefined) {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Authenticated user context is missing',
      retryable: false,
    });
  }
  return { userId, requestId: String(request.id) };
}

function avatarView({ avatar, url }: PublishedAvatar): AvatarResponse['data'] {
  return {
    asset_id: avatar.assetId,
    content_type: avatar.contentType,
    byte_size: avatar.byteSize,
    accepted_at: avatar.acceptedAt.toISOString(),
    url,
  };
}

/**
 * The Avatar of the signed-in AIHUB User Account (ADR-0068). The account is
 * always the one the token names; no route takes a user id.
 */
@Controller()
@UseGuards(UserAccessJwtGuard)
export class AvatarController {
  constructor(private readonly uploads: AvatarUploadService) {}

  @Post(PUBLIC_ROUTES['me.avatar.uploads.create'].path)
  @HttpCode(PUBLIC_ROUTES['me.avatar.uploads.create'].successStatus)
  // The upload URL is a write credential for one object.
  @Header('Cache-Control', 'no-store')
  async requestUpload(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AvatarUploadResponse> {
    const { userId, requestId } = authenticatedUser(request);
    if (!Value.Check(CreateAvatarUploadRequestSchema, body)) {
      throw invalidRequest();
    }

    const upload = await this.uploads.requestUpload({
      userId,
      contentType: body.content_type,
      byteSize: body.byte_size,
    });

    return {
      data: {
        asset_id: upload.assetId,
        upload_url: upload.uploadUrl,
        method: 'PUT',
        headers: {
          'Content-Type': upload.contentType,
          'Content-Length': String(upload.byteSize),
          'Cache-Control': AVATAR_CACHE_CONTROL,
        },
        expires_at: upload.expiresAt.toISOString(),
      },
      meta: { request_id: requestId },
    };
  }

  @Post(PUBLIC_ROUTES['me.avatar.uploads.complete'].path)
  async completeUpload(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('assetId') assetId: string,
  ): Promise<AvatarResponse> {
    const { userId, requestId } = authenticatedUser(request);

    const completed = await this.uploads.completeUpload({ userId, assetId });

    reply.status(
      completed.created
        ? PUBLIC_ROUTES['me.avatar.uploads.complete'].successStatus
        : 200,
    );
    return { data: avatarView(completed), meta: { request_id: requestId } };
  }

  @Get(PUBLIC_ROUTES['me.avatar.read'].path)
  @HttpCode(PUBLIC_ROUTES['me.avatar.read'].successStatus)
  async readAvatar(
    @Req() request: FastifyRequest,
  ): Promise<ReadAvatarResponse> {
    const { userId, requestId } = authenticatedUser(request);
    const published = await this.uploads.readAvatar(userId);
    return {
      data: { avatar: published === undefined ? null : avatarView(published) },
      meta: { request_id: requestId },
    };
  }

  @Delete(PUBLIC_ROUTES['me.avatar.remove'].path)
  @HttpCode(PUBLIC_ROUTES['me.avatar.remove'].successStatus)
  async removeAvatar(@Req() request: FastifyRequest): Promise<void> {
    const { userId } = authenticatedUser(request);
    await this.uploads.removeAvatar(userId);
  }
}
