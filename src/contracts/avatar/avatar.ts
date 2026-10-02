import { FormatRegistry, type Static, Type } from '@sinclair/typebox';

// TypeBox rejects an unregistered format outright, so `date-time` has to be
// taught once before any boundary can validate a timestamp against it.
if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set(
    'date-time',
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) && !Number.isNaN(Date.parse(value)),
  );
}

const AvatarAssetIdSchema = Type.String({
  pattern: '^ava_[0-9A-HJKMNP-TV-Z]{26}$',
});

const AvatarContentTypeSchema = Type.Union([
  Type.Literal('image/jpeg'),
  Type.Literal('image/png'),
  Type.Literal('image/webp'),
]);

const MetaSchema = Type.Object(
  { request_id: Type.String({ pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$' }) },
  { additionalProperties: false },
);

/**
 * The size has no maximum here on purpose: an oversized declaration is a
 * distinct `413 PAYLOAD_TOO_LARGE`, not a malformed request.
 */
export const CreateAvatarUploadRequestSchema = Type.Object(
  {
    content_type: AvatarContentTypeSchema,
    byte_size: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

/**
 * Everything a client needs to send the bytes straight to storage. The headers
 * are part of the signature: sending different values fails the upload.
 */
export const AvatarUploadResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        asset_id: AvatarAssetIdSchema,
        upload_url: Type.String({ pattern: '^https://' }),
        method: Type.Literal('PUT'),
        headers: Type.Object(
          {
            'Content-Type': AvatarContentTypeSchema,
            'Content-Length': Type.String({ pattern: '^[1-9][0-9]*$' }),
          },
          { additionalProperties: false },
        ),
        expires_at: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
    meta: MetaSchema,
  },
  { additionalProperties: false },
);

export type AvatarUploadResponse = Static<typeof AvatarUploadResponseSchema>;

/** Describes the recorded image. Never the object key, bucket, or a URL. */
export const AvatarResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        asset_id: AvatarAssetIdSchema,
        content_type: AvatarContentTypeSchema,
        byte_size: Type.Integer({ minimum: 1 }),
        accepted_at: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
    meta: MetaSchema,
  },
  { additionalProperties: false },
);

export type AvatarResponse = Static<typeof AvatarResponseSchema>;
