import { type Static, Type } from '@sinclair/typebox';
import '@/contracts/date-time-format';

const MetaSchema = Type.Object(
  { request_id: Type.String() },
  { additionalProperties: false },
);

export const CreateWritingChartUploadRequestSchema = Type.Object(
  {
    content_type: Type.Union([
      Type.Literal('image/jpeg'),
      Type.Literal('image/png'),
      Type.Literal('image/webp'),
    ]),
    byte_size: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const UploadGrantDataSchema = Type.Object(
  {
    asset_id: Type.String({ pattern: '^chart_[0-9A-HJKMNP-TV-Z]{26}$' }),
    upload_url: Type.String({ format: 'uri' }),
    method: Type.Literal('POST'),
    fields: Type.Record(Type.String(), Type.String()),
    expires_at: Type.String({ format: 'date-time' }),
    intent_expires_at: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);

export const WritingChartUploadGrantResponseSchema = Type.Object(
  { data: UploadGrantDataSchema, meta: MetaSchema },
  { additionalProperties: false },
);

export const WritingChartAssetResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        asset_id: Type.String({ pattern: '^chart_[0-9A-HJKMNP-TV-Z]{26}$' }),
        image_url: Type.String({ format: 'uri' }),
        content_type: Type.Union([
          Type.Literal('image/jpeg'),
          Type.Literal('image/png'),
          Type.Literal('image/webp'),
        ]),
        byte_size: Type.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 }),
        published_at: Type.String({ format: 'date-time' }),
        expires_at: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
    meta: MetaSchema,
  },
  { additionalProperties: false },
);

export type CreateWritingChartUploadRequest = Static<
  typeof CreateWritingChartUploadRequestSchema
>;
export type WritingChartUploadGrantResponse = Static<
  typeof WritingChartUploadGrantResponseSchema
>;
export type WritingChartAssetResponse = Static<
  typeof WritingChartAssetResponseSchema
>;
