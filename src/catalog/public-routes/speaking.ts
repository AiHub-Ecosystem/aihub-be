import {
  CreateSpeakingAudioUploadRequestSchema,
  SpeakingAudioAssetResponseSchema,
  SpeakingAudioUploadUrlResponseSchema,
} from '@/contracts/speaking/audio-upload';
import {
  SpeakingGradingJobPollResponseSchema,
  SpeakingGradingJobSubmitRequestSchema,
  SpeakingGradingJobSubmitResponseSchema,
} from '@/contracts/speaking/v2/grading-job';

export const SPEAKING_PUBLIC_ROUTES = {
  'speaking.gradingJobs.create': {
    cacheControl: {
      value: 'no-store',
      description: 'Speaking grading job responses must not be cached.',
    },
    openApi: {
      summary: 'Submit an asynchronous Speaking grading job',
      description: [
        'Creates a durable job that grades one question from a previously uploaded Audio asset. The request is admitted synchronously and returns without calling the AI Service; poll the returned `job_id` for the result.',
        'An optional `Idempotency-Key` replays the original 202 response for the same request body.',
      ].join('\n\n'),
      successDescription:
        'The queued job identifier. No Speaking result is dispatched or returned by this request.',
    },
    method: 'POST',
    timeoutMs: 10_000,
    path: '/v2/ielts/speaking/grading-jobs',
    callerAuth: 'api-key',
    requiredScope: 'speaking.grade',
    organizationResolution: 'caller',
    successStatus: 202,
    publishedIdentityScope: 'user',
    idempotency: 'optional',
    requestSchema: SpeakingGradingJobSubmitRequestSchema,
    responseSchema: SpeakingGradingJobSubmitResponseSchema,
    errorStatuses: [400, 401, 403, 404, 409, 413, 429, 500, 503],
  },
  'speaking.gradingJobs.get': {
    cacheControl: {
      value: 'no-store',
      description: 'Speaking grading job responses must not be cached.',
    },
    openApi: {
      summary: 'Poll a Speaking grading job',
      description:
        'Returns the job state and, when terminal, its Speaking v2 question result or safe error. Only the same Organization and End-User ID can read the job.',
      parameters: [
        {
          name: 'job_id',
          in: 'path',
          required: true,
          description: 'The job identifier returned by the submit request.',
          schema: { type: 'string', pattern: '^sgj_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      successDescription: 'The current state of the owned grading job.',
    },
    method: 'GET',
    timeoutMs: 30_000,
    path: '/v2/ielts/speaking/grading-jobs/:jobId',
    callerAuth: 'api-key',
    requiredScope: 'speaking.grade',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: SpeakingGradingJobPollResponseSchema,
    errorStatuses: [400, 401, 403, 404, 429, 500, 503],
  },
  'speaking.audioUploads.create': {
    cacheControl: {
      value: 'no-store',
      description: 'Upload URLs and Audio metadata must not be cached.',
    },
    openApi: {
      summary: 'Create a Speaking Audio upload intent',
      description: [
        'Creates a one-hour intent bound to the Organization and exact End-User ID resolved from `X-User-Identity`. The response contains a five-minute presigned `PUT` URL; send the audio directly to that URL with the returned `Content-Type` and `Content-Length` headers.',
        'The URL is a write credential. Do not log, persist, or expose it. The intent is not an Audio asset until completion verifies the stored object.',
      ].join('\n\n'),
      successDescription:
        'Returns the same server-generated key and signed headers for the upload intent.',
    },
    method: 'POST',
    path: '/v1/speaking/audio/uploads',
    callerAuth: 'api-key',
    requiredScope: 'speaking.grade',
    organizationResolution: 'caller',
    successStatus: 201,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: CreateSpeakingAudioUploadRequestSchema,
    responseSchema: SpeakingAudioUploadUrlResponseSchema,
    errorStatuses: [400, 401, 403, 413, 429, 500, 503],
  },
  'speaking.audioUploads.refresh': {
    cacheControl: {
      value: 'no-store',
      description: 'Upload URLs and Audio metadata must not be cached.',
    },
    openApi: {
      summary: 'Refresh a Speaking Audio upload URL',
      description:
        'Issues another five-minute URL for the same open intent, key, content type, and byte size. It does not extend the original one-hour intent expiry.',
      parameters: [
        {
          name: 'asset_id',
          in: 'path',
          required: true,
          description:
            'The asset ID returned when the upload intent was created.',
          schema: { type: 'string', pattern: '^aud_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      successDescription:
        'Returns the same server-generated key and signed headers for the upload intent.',
    },
    method: 'POST',
    path: '/v1/speaking/audio/uploads/:assetId/refresh',
    callerAuth: 'api-key',
    requiredScope: 'speaking.grade',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: SpeakingAudioUploadUrlResponseSchema,
    errorStatuses: [400, 401, 403, 404, 429, 500, 503],
  },
  'speaking.audioUploads.complete': {
    cacheControl: {
      value: 'no-store',
      description: 'Upload URLs and Audio metadata must not be cached.',
    },
    openApi: {
      summary: 'Complete a Speaking Audio upload',
      description: [
        'Verifies the stored object metadata at the exact key recorded by the intent. A valid object creates the Audio asset and sets `retention_expires_at` to 30 days after acceptance; a missing object leaves the intent retryable, while invalid metadata rejects the intent.',
        'Only the same Organization and End-User ID can complete the intent. Repeating a successful completion returns the same Audio asset.',
      ].join('\n\n'),
      parameters: [
        {
          name: 'asset_id',
          in: 'path',
          required: true,
          description:
            'The asset ID returned when the upload intent was created.',
          schema: { type: 'string', pattern: '^aud_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      successDescription: 'The verified Audio asset created by this request.',
    },
    method: 'POST',
    timeoutMs: 10_000,
    path: '/v1/speaking/audio/uploads/:assetId/complete',
    callerAuth: 'api-key',
    requiredScope: 'speaking.grade',
    organizationResolution: 'caller',
    successStatus: 201,
    alternateSuccesses: [
      {
        status: 200,
        description:
          'This intent was already completed; the same Audio asset is returned.',
        responseSchema: SpeakingAudioAssetResponseSchema,
      },
    ],
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: SpeakingAudioAssetResponseSchema,
    errorStatuses: [400, 401, 403, 404, 413, 429, 500, 503],
  },
} as const;
