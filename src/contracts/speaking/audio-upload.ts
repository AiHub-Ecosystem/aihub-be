import { type Static, Type } from '@sinclair/typebox';

import {
  SPEAKING_AUDIO_CONTENT_TYPES,
  SPEAKING_AUDIO_MAX_BYTES,
} from '@/modules/speaking/domain/speaking-audio-asset';

const SpeakingAudioContentTypeSchema = Type.Union(
  SPEAKING_AUDIO_CONTENT_TYPES.map((contentType) => Type.Literal(contentType)),
);

const MetaSchema = Type.Object(
  { request_id: Type.String({ pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$' }) },
  { additionalProperties: false },
);

const SpeakingAudioAssetIdSchema = Type.String({
  pattern: '^aud_[0-9A-HJKMNP-TV-Z]{26}$',
});

export const CreateSpeakingAudioUploadRequestSchema = Type.Object(
  {
    content_type: SpeakingAudioContentTypeSchema,
    byte_size: Type.Integer({ minimum: 100 }),
  },
  { additionalProperties: false },
);

export type CreateSpeakingAudioUploadRequest = Static<
  typeof CreateSpeakingAudioUploadRequestSchema
>;

export const SpeakingAudioUploadUrlResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        asset_id: SpeakingAudioAssetIdSchema,
        upload_url: Type.String({ pattern: '^https://' }),
        method: Type.Literal('PUT'),
        headers: Type.Object(
          {
            'Content-Type': SpeakingAudioContentTypeSchema,
            'Content-Length': Type.String({ pattern: '^[1-9][0-9]*$' }),
          },
          { additionalProperties: false },
        ),
        expires_at: Type.String({ format: 'date-time' }),
        intent_expires_at: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
    meta: MetaSchema,
  },
  { additionalProperties: false },
);

export type SpeakingAudioUploadUrlResponse = Static<
  typeof SpeakingAudioUploadUrlResponseSchema
>;

export const SpeakingAudioAssetResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        asset_id: SpeakingAudioAssetIdSchema,
        content_type: SpeakingAudioContentTypeSchema,
        byte_size: Type.Integer({
          minimum: 100,
          maximum: SPEAKING_AUDIO_MAX_BYTES,
        }),
        accepted_at: Type.String({ format: 'date-time' }),
        retention_expires_at: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
    meta: MetaSchema,
  },
  { additionalProperties: false },
);

export type SpeakingAudioAssetResponse = Static<
  typeof SpeakingAudioAssetResponseSchema
>;
