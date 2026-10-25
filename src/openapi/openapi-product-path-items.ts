import { Type } from '@sinclair/typebox';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import type { ErrorCode } from '@/common/errors/error-code';
import type { HttpStatus } from '@/common/errors/error-registry';
import { MintSandboxAssertionResponseSchema } from '@/contracts/sandbox/assertion';
import { SpeakingQuestionsQuerySchema } from '@/contracts/speaking/questions';
import {
  routeErrorResponsesOf,
  routeIdentityScopeOf,
  routePathOf,
  routeSchemaOf,
  routeSecurityOf,
  routeSuccessKeyOf,
} from './openapi-shared';

/**
 * Its path, schemas, error statuses, and security come from
 * `PUBLIC_ROUTES`; the description and the envelope stay here, because those
 * are what make it this route.
 *
 * It is not a dispatch operation: it has no downstream service, no downstream
 * contract, and no scope, so it does not belong in `OPERATION_CATALOG` either.
 * Putting it there to reuse `operationToPathItem` would put a phantom proxy
 * operation in front of every reader of this document.
 *
 * The envelope is narrower than a proxied operation's for the same reason. A
 * dispatch envelope reports downstream and gateway timings for a call that
 * reached an AI service; this one reaches none, and publishing zeroed timings
 * would describe a measurement nobody took.
 */
export function sandboxAssertionPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  const id = 'sandbox.assertions.mint' as const;
  const responses: Record<string, unknown> = {
    '200': {
      description: 'A freshly signed assertion for the sandbox organization',
      content: {
        'application/json': {
          schema: Type.Object(
            {
              data: MintSandboxAssertionResponseSchema,
              meta: Type.Object(
                {
                  request_id: Type.String({
                    pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$',
                  }),
                },
                { additionalProperties: false },
              ),
            },
            { additionalProperties: false },
          ),
        },
      },
    },
  };

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Mint a sandbox user assertion',
      description: [
        'Issues a short-lived user assertion for the sandbox organization, so that exercising the API does not require holding an organization signing key.',
        'Available only to API keys belonging to a configured sandbox organization; every other key is refused. Deployments with no sandbox configured answer 404.',
        'This is not the integration pattern for a customer with their own backend. Such a customer signs assertions from their own identity provider and never calls this route.',
      ].join('\n\n'),
      ...routeIdentityScopeOf(id),
      ...routeSecurityOf(id),
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        ...responses,
        ...routeErrorResponsesOf(id, groupedErrors),
      },
    },
  };
}

export function sandboxDemoKeyValidationPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  const id = 'sandbox.demo-key.validate' as const;
  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Validate a demo key for the selected environment',
      description: [
        'Customer Web BFF only. Checks that the active API key is bound to the selected environment and carries the requested Writing or Speaking grading scope, then reports which user-identity input the demo collects next.',
        '`user_identity_mode` is `signed_assertion` when the Organization has an active Identity Configuration and `declared_id` otherwise. It selects the browser input only and exposes no Identity Configuration detail.',
        'This route does not dispatch to an AI service and does not consume grading quota. It is rate-limited and advisory; each upload and grading operation authenticates the key again and enforces the Organization identity policy. Active Identity Configuration requires a valid Signed User Assertion; otherwise, the Declared User ID flow applies.',
      ].join('\n\n'),
      ...routeIdentityScopeOf(id),
      ...routeSecurityOf(id),
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'X-AIHUB-Visitor-IP',
          in: 'header',
          required: true,
          schema: { type: 'string', format: 'ip' },
          description:
            'Trusted visitor IP forwarded by the authenticated Customer Web BFF for per-visitor failed-key protection.',
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'Key is eligible for the requested live demo skill',
          content: {
            'application/json': {
              schema: Type.Object(
                {
                  data: routeSchemaOf(id, 'response'),
                  meta: Type.Object(
                    {
                      request_id: Type.String({
                        pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$',
                      }),
                    },
                    { additionalProperties: false },
                  ),
                },
                { additionalProperties: false },
              ),
            },
          },
        },
        ...routeErrorResponsesOf(id, groupedErrors),
      },
    },
  };
}

export function avatarUploadPathItem(): Record<string, unknown> {
  const id = 'me.avatar.uploads.create' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Request an Avatar upload URL',
      description:
        'Mints a presigned `PUT` URL that writes one object for the signed-in AIHUB User Account, with the declared content type and `Cache-Control: public, max-age=3600` bound into the signature. `Content-Length` reports the declared size but is not signed because browser Fetch controls it; send the image as the request body and let the browser manage that header. The bytes go straight to storage, never through AIHUB. Nothing is recorded until completion verifies the stored object, including its actual size and type, within one hour of upload. Allowed types are `image/jpeg`, `image/png`, and `image/webp`, up to 2 MiB; the URL expires after 5 minutes. An account that already has an Avatar may request one to replace it.',
      ...routeIdentityScopeOf(id),
      ...routeSecurityOf(id),
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(id)]: {
          description:
            'Upload URL minted. The URL is a write credential for one object and is returned only here.',
          headers: {
            'Cache-Control': {
              schema: { type: 'string', enum: ['no-store'] },
            },
          },
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

export function avatarCompletePathItem(): Record<string, unknown> {
  const id = 'me.avatar.uploads.complete' as const;
  const avatarContent = {
    'application/json': { schema: routeSchemaOf(id, 'response') },
  };

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Complete an Avatar upload',
      description:
        'Checks the object that actually landed for this asset and records it as the Avatar of the signed-in AIHUB User Account. An object that is missing, or that was stored more than an hour ago, answers `404` and an expired one is deleted; one that is larger than 2 MiB, has an unsupported type, or is empty is refused and deleted. When the account already has a different Avatar, its image is deleted first and the new one replaces it; if that delete fails the account keeps its Avatar and the call answers `503`, and retrying finishes the replacement. `409 AVATAR_CHANGED` means another request changed the Avatar first; re-read before retrying. The response describes the image, including its published `url`.',
      ...routeIdentityScopeOf(id),
      ...routeSecurityOf(id),
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'asset_id',
          in: 'path',
          required: true,
          description: 'The asset id returned when the upload URL was minted.',
          schema: { type: 'string', pattern: '^ava_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'Avatar recorded by this call, first or replacement.',
          content: avatarContent,
        },
        '200': {
          description:
            'This asset was already recorded as the Avatar by an earlier completion; the same Avatar is returned.',
          content: avatarContent,
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

export function avatarItemPathItem(): Record<string, unknown> {
  const read = 'me.avatar.read' as const;
  const remove = 'me.avatar.remove' as const;

  return {
    [PUBLIC_ROUTES[read].method.toLowerCase()]: {
      operationId: read,
      summary: 'Read the Avatar',
      description:
        'Describes the Avatar of the signed-in AIHUB User Account, or answers `avatar: null` when the account has none; that is a normal state, not an error. `url` is the published origin URL of the image: load it with a plain unauthenticated `GET`, which AIHUB does not proxy. Each upload has a new URL, and a removed image may stay in caches for up to an hour.',
      ...routeIdentityScopeOf(read),
      ...routeSecurityOf(read),
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      responses: {
        [routeSuccessKeyOf(read)]: {
          description: 'The Avatar, or `null` when the account has none.',
          content: {
            'application/json': { schema: routeSchemaOf(read, 'response') },
          },
        },
        ...routeErrorResponsesOf(read),
      },
    },
    [PUBLIC_ROUTES[remove].method.toLowerCase()]: {
      operationId: remove,
      summary: 'Remove the Avatar',
      description:
        'Deletes the Avatar image and its record for the signed-in AIHUB User Account. Idempotent: an account with no Avatar also answers `204`. If the image cannot be deleted the account keeps its Avatar and the call answers `503`; retrying finishes the removal. `409 AVATAR_CHANGED` means another request replaced the Avatar meanwhile, and the replacement is kept.',
      ...routeIdentityScopeOf(remove),
      ...routeSecurityOf(remove),
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      responses: {
        [routeSuccessKeyOf(remove)]: {
          description: 'The account has no Avatar.',
        },
        ...routeErrorResponsesOf(remove),
      },
    },
  };
}

export function speakingQuestionsPathItem(): Record<string, unknown> {
  const id = 'speaking.questions' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'List Speaking questions',
      ...routeSecurityOf(id),
      parameters: [
        {
          name: 'part',
          in: 'query',
          required: false,
          description: 'Filter by Speaking part; omit to list all parts.',
          schema: SpeakingQuestionsQuerySchema.properties.part,
        },
      ],
      responses: {
        '200': {
          description: 'Speaking questions and signed audio URLs',
          headers: {
            'Cache-Control': {
              description: 'This response must not be cached.',
              schema: { type: 'string', enum: ['no-store'] },
            },
          },
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

export function speakingAudioUploadPathItems(): Record<
  string,
  Record<string, unknown>
> {
  const create = 'speaking.audioUploads.create' as const;
  const refresh = 'speaking.audioUploads.refresh' as const;
  const complete = 'speaking.audioUploads.complete' as const;
  const sharedParameters = [
    { $ref: '#/components/parameters/CorrelationId' },
    { $ref: '#/components/parameters/UserIdentity' },
  ];
  const assetIdParameter = {
    name: 'assetId',
    in: 'path',
    required: true,
    description: 'The asset ID returned when the upload intent was created.',
    schema: { type: 'string', pattern: '^aud_[0-9A-HJKMNP-TV-Z]{26}$' },
  };
  const noStore = {
    'Cache-Control': {
      description: 'Upload URLs and Audio metadata must not be cached.',
      schema: { type: 'string', enum: ['no-store'] },
    },
  };
  const urlSchema = routeSchemaOf(create, 'response');
  const assetSchema = routeSchemaOf(complete, 'response');
  const urlResponses = (routeId: typeof create | typeof refresh) => ({
    [routeSuccessKeyOf(routeId)]: {
      description:
        'Returns the same server-generated key and signed headers for the upload intent.',
      headers: noStore,
      content: { 'application/json': { schema: urlSchema } },
    },
    ...routeErrorResponsesOf(routeId),
  });

  return {
    [routePathOf(create)]: {
      post: {
        operationId: create,
        summary: 'Create a Speaking Audio upload intent',
        description: [
          'Creates a one-hour intent bound to the Organization and exact End-User ID resolved from `X-User-Identity`. The response contains a five-minute presigned `PUT` URL; send the audio directly to that URL with the returned `Content-Type` and `Content-Length` headers.',
          'The URL is a write credential. Do not log, persist, or expose it. The intent is not an Audio asset until completion verifies the stored object.',
        ].join('\n\n'),
        ...routeIdentityScopeOf(create),
        ...routeSecurityOf(create),
        parameters: sharedParameters,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: routeSchemaOf(create, 'request') },
          },
        },
        responses: urlResponses(create),
      },
    },
    [routePathOf(refresh)]: {
      post: {
        operationId: refresh,
        summary: 'Refresh a Speaking Audio upload URL',
        description:
          'Issues another five-minute URL for the same open intent, key, content type, and byte size. It does not extend the original one-hour intent expiry.',
        ...routeIdentityScopeOf(refresh),
        ...routeSecurityOf(refresh),
        parameters: [...sharedParameters, assetIdParameter],
        responses: urlResponses(refresh),
      },
    },
    [routePathOf(complete)]: {
      post: {
        operationId: complete,
        summary: 'Complete a Speaking Audio upload',
        description: [
          'Verifies the stored object metadata at the exact key recorded by the intent. A valid object creates the Audio asset and sets `retention_expires_at` to 30 days after acceptance; a missing object leaves the intent retryable, while invalid metadata rejects the intent.',
          'Only the same Organization and End-User ID can complete the intent. Repeating a successful completion returns the same Audio asset.',
        ].join('\n\n'),
        ...routeIdentityScopeOf(complete),
        ...routeSecurityOf(complete),
        parameters: [...sharedParameters, assetIdParameter],
        responses: {
          [routeSuccessKeyOf(complete)]: {
            description: 'The verified Audio asset created by this request.',
            headers: noStore,
            content: { 'application/json': { schema: assetSchema } },
          },
          '200': {
            description:
              'This intent was already completed; the same Audio asset is returned.',
            headers: noStore,
            content: { 'application/json': { schema: assetSchema } },
          },
          ...routeErrorResponsesOf(complete),
        },
      },
    },
  };
}

export function writingChartUploadPathItems(): Record<
  string,
  Record<string, unknown>
> {
  const create = 'writing.chartUploads.create' as const;
  const refresh = 'writing.chartUploads.refresh' as const;
  const complete = 'writing.chartUploads.complete' as const;
  const sharedParameters = [
    { $ref: '#/components/parameters/CorrelationId' },
    { $ref: '#/components/parameters/UserIdentity' },
  ];
  const assetIdParameter = {
    name: 'assetId',
    in: 'path',
    required: true,
    description:
      'The chart asset ID returned when the upload intent was created.',
    schema: { type: 'string', pattern: '^chart_[0-9A-HJKMNP-TV-Z]{26}$' },
  };
  const noStore = {
    'Cache-Control': {
      description: 'Upload URLs and chart metadata must not be cached.',
      schema: { type: 'string', enum: ['no-store'] },
    },
  };
  const grantSchema = routeSchemaOf(create, 'response');
  const assetSchema = routeSchemaOf(complete, 'response');
  const grantResponse = (id: typeof create | typeof refresh) => ({
    [routeSuccessKeyOf(id)]: {
      description:
        'A five-minute signed POST policy and form fields for private staging storage, limited to the declared byte size.',
      headers: noStore,
      content: { 'application/json': { schema: grantSchema } },
    },
    ...routeErrorResponsesOf(id),
  });
  return {
    [routePathOf(create)]: {
      post: {
        operationId: create,
        summary: 'Create a Writing Task 1 chart upload intent',
        description: [
          'Requires an API key with `writing.grade` and the same declared or signed `X-User-Identity` accepted by Writing Task 1 grading. The intent is bound to that Organization, End User, and API-key environment.',
          'Upload directly to the returned URL as `multipart/form-data`, including every returned `fields` entry and the file under `file`. The signed policy limits the stored file to the declared byte size. Staging remains private. The policy expires after five minutes; the intent expires after one hour and can be refreshed without extending that deadline. Limits are five intents and five published charts per Organization in a rolling hour.',
        ].join('\n\n'),
        ...routeIdentityScopeOf(create),
        ...routeSecurityOf(create),
        parameters: sharedParameters,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: routeSchemaOf(create, 'request') },
          },
        },
        responses: grantResponse(create),
      },
    },
    [routePathOf(refresh)]: {
      post: {
        operationId: refresh,
        summary: 'Refresh a Writing Task 1 chart upload URL',
        description:
          'Refreshes the signed URL for the same private staging object without extending the intent deadline.',
        ...routeIdentityScopeOf(refresh),
        ...routeSecurityOf(refresh),
        parameters: [...sharedParameters, assetIdParameter],
        responses: grantResponse(refresh),
      },
    },
    [routePathOf(complete)]: {
      post: {
        operationId: complete,
        summary: 'Verify and publish a Writing Task 1 chart',
        description: [
          'Downloads the complete staged object (up to 10 MiB), decodes and verifies the JPEG, PNG, or WebP image, applies EXIF orientation, strips source metadata, and re-encodes it before publishing the sanitized bytes. Completion returns 413 and rejects the intent if the sanitized output exceeds 10 MiB; malformed or mismatched images are rejected with 400.',
          'The returned `image_url` is anonymously readable and shareable until it expires 24 hours after publication. Anyone who learns the URL can read and reuse it. Only the same Organization, End User, and environment can complete the upload.',
        ].join('\n\n'),
        ...routeIdentityScopeOf(complete),
        ...routeSecurityOf(complete),
        parameters: [...sharedParameters, assetIdParameter],
        responses: {
          [routeSuccessKeyOf(complete)]: {
            description: 'The public image URL and its fixed expiration time.',
            headers: noStore,
            content: { 'application/json': { schema: assetSchema } },
          },
          ...routeErrorResponsesOf(complete),
        },
      },
    },
  };
}
