import {
  CreateWritingChartUploadRequestSchema,
  WritingChartAssetResponseSchema,
  WritingChartUploadGrantResponseSchema,
} from '@/contracts/writing/chart-upload';

export const WRITING_PUBLIC_ROUTES = {
  'writing.chartUploads.create': {
    cacheControl: {
      value: 'no-store',
      description: 'Upload URLs and chart metadata must not be cached.',
    },
    openApi: {
      summary: 'Create a Writing Task 1 chart upload intent',
      description: [
        'Requires an API key with `writing.grade` or `writing.exercise` and the same declared or signed `X-User-Identity` accepted by Writing Task 1 grading. The intent is bound to that Organization, End User, and API-key environment.',
        'Upload directly to the returned URL as `multipart/form-data`, including every returned `fields` entry and the file under `file`. The signed policy limits the stored file to the declared byte size. Staging remains private. The policy expires after five minutes; the intent expires after one hour and can be refreshed without extending that deadline. Limits are five intents and five published charts per Organization in a rolling hour.',
      ].join('\n\n'),
      successDescription:
        'A five-minute signed POST policy and form fields for private staging storage, limited to the declared byte size.',
    },
    method: 'POST',
    path: '/v1/ielts/writing/task1/chart-uploads',
    callerAuth: 'api-key',
    requiredScope: 'writing.grade',
    acceptedScopes: ['writing.exercise'],
    organizationResolution: 'caller',
    successStatus: 201,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: CreateWritingChartUploadRequestSchema,
    responseSchema: WritingChartUploadGrantResponseSchema,
    errorStatuses: [400, 401, 403, 413, 429, 500, 503],
  },
  'writing.chartUploads.refresh': {
    cacheControl: {
      value: 'no-store',
      description: 'Upload URLs and chart metadata must not be cached.',
    },
    openApi: {
      summary: 'Refresh a Writing Task 1 chart upload URL',
      description:
        'Requires an API key with `writing.grade` or `writing.exercise`. Refreshes the signed URL for the same private staging object without extending the intent deadline.',
      parameters: [
        {
          name: 'asset_id',
          in: 'path',
          required: true,
          description:
            'The chart asset ID returned when the upload intent was created.',
          schema: {
            type: 'string',
            pattern: '^chart_[0-9A-HJKMNP-TV-Z]{26}$',
          },
        },
      ],
      successDescription:
        'A five-minute signed POST policy and form fields for private staging storage, limited to the declared byte size.',
    },
    method: 'POST',
    path: '/v1/ielts/writing/task1/chart-uploads/:assetId/refresh',
    callerAuth: 'api-key',
    requiredScope: 'writing.grade',
    acceptedScopes: ['writing.exercise'],
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: WritingChartUploadGrantResponseSchema,
    errorStatuses: [400, 401, 403, 404, 429, 500, 503],
  },
  'writing.chartUploads.complete': {
    cacheControl: {
      value: 'no-store',
      description: 'Upload URLs and chart metadata must not be cached.',
    },
    openApi: {
      summary: 'Verify and publish a Writing Task 1 chart',
      description: [
        'Requires an API key with `writing.grade` or `writing.exercise`.',
        'Downloads the complete staged object (up to 10 MiB), decodes and verifies the JPEG, PNG, or WebP image, applies EXIF orientation, strips source metadata, and re-encodes it before publishing the sanitized bytes. Completion returns 413 and rejects the intent if the sanitized output exceeds 10 MiB; malformed or mismatched images are rejected with 400.',
        'The returned `image_url` is anonymously readable and shareable until it expires 24 hours after publication. Anyone who learns the URL can read and reuse it. Only the same Organization, End User, and environment can complete the upload.',
      ].join('\n\n'),
      parameters: [
        {
          name: 'asset_id',
          in: 'path',
          required: true,
          description:
            'The chart asset ID returned when the upload intent was created.',
          schema: {
            type: 'string',
            pattern: '^chart_[0-9A-HJKMNP-TV-Z]{26}$',
          },
        },
      ],
      successDescription: 'The public image URL and its fixed expiration time.',
    },
    method: 'POST',
    timeoutMs: 10_000,
    path: '/v1/ielts/writing/task1/chart-uploads/:assetId/complete',
    callerAuth: 'api-key',
    requiredScope: 'writing.grade',
    acceptedScopes: ['writing.exercise'],
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: WritingChartAssetResponseSchema,
    errorStatuses: [400, 401, 403, 404, 413, 429, 500, 503],
  },
} as const;
