import { ReadCurrentUserResponseSchema } from '@/contracts/auth/local-auth';
import {
  AvatarResponseSchema,
  AvatarUploadResponseSchema,
  CreateAvatarUploadRequestSchema,
  ReadAvatarResponseSchema,
} from '@/contracts/avatar/avatar';
import {
  MintSandboxAssertionRequestSchema,
  MintSandboxAssertionResponseSchema,
} from '@/contracts/sandbox/assertion';
import {
  SandboxDemoKeyValidationRequestSchema,
  SandboxDemoKeyValidationResponseSchema,
} from '@/contracts/sandbox/demo-key-validation';

export const AVATAR_PUBLIC_ROUTES = {
  'me.avatar.uploads.create': {
    cacheControl: { value: 'no-store' },
    openApi: {
      summary: 'Request an Avatar upload URL',
      description:
        'Mints a presigned `PUT` URL that writes one object for the signed-in AIHUB User Account, with the declared content type and `Cache-Control: public, max-age=3600` bound into the signature. `Content-Length` reports the declared size but is not signed because browser Fetch controls it; send the image as the request body and let the browser manage that header. The bytes go straight to storage, never through AIHUB. Nothing is recorded until completion verifies the stored object, including its actual size and type, within one hour of upload. Allowed types are `image/jpeg`, `image/png`, and `image/webp`, up to 2 MiB; the URL expires after 5 minutes. An account that already has an Avatar may request one to replace it.',
      successDescription:
        'Upload URL minted. The URL is a write credential for one object and is returned only here.',
    },
    method: 'POST',
    path: '/v1/me/avatar/uploads',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 201,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: CreateAvatarUploadRequestSchema,
    responseSchema: AvatarUploadResponseSchema,
    errorStatuses: [400, 401, 413, 429, 500, 503],
  },
  // `201` when this call records the Avatar, first or replacement; a repeated
  // completion of the same asset answers `200` with the same body.
  'me.avatar.uploads.complete': {
    openApi: {
      summary: 'Complete an Avatar upload',
      description:
        'Checks the object that actually landed for this asset and records it as the Avatar of the signed-in AIHUB User Account. An object that is missing, or that was stored more than an hour ago, answers `404` and an expired one is deleted; one that is larger than 2 MiB, has an unsupported type, or is empty is refused and deleted. When the account already has a different Avatar, its image is deleted first and the new one replaces it; if that delete fails the account keeps its Avatar and the call answers `503`, and retrying finishes the replacement. `409 AVATAR_CHANGED` means another request changed the Avatar first; re-read before retrying. The response describes the image, including its published `url`.',
      parameters: [
        {
          name: 'asset_id',
          in: 'path',
          required: true,
          description: 'The asset id returned when the upload URL was minted.',
          schema: { type: 'string', pattern: '^ava_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      successDescription: 'Avatar recorded by this call, first or replacement.',
    },
    method: 'POST',
    timeoutMs: 10_000,
    path: '/v1/me/avatar/uploads/:assetId/complete',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 201,
    alternateSuccesses: [
      {
        status: 200,
        description:
          'This asset was already recorded as the Avatar by an earlier completion; the same Avatar is returned.',
        responseSchema: AvatarResponseSchema,
      },
    ],
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: AvatarResponseSchema,
    errorStatuses: [400, 401, 404, 409, 413, 500, 503],
  },
  // Always `200`: an account with no Avatar answers `avatar: null`.
  'me.avatar.read': {
    openApi: {
      summary: 'Read the Avatar',
      description:
        'Describes the Avatar of the signed-in AIHUB User Account, or answers `avatar: null` when the account has none; that is a normal state, not an error. `url` is the published origin URL of the image: load it with a plain unauthenticated `GET`, which AIHUB does not proxy. Each upload has a new URL, and a removed image may stay in caches for up to an hour.',
      successDescription: 'The Avatar, or `null` when the account has none.',
    },
    method: 'GET',
    path: '/v1/me/avatar',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ReadAvatarResponseSchema,
    errorStatuses: [401, 500, 503],
  },
  // Always `204`, including for an account with no Avatar: absence is what
  // was asked for.
  'me.avatar.remove': {
    openApi: {
      summary: 'Remove the Avatar',
      description:
        'Deletes the Avatar image and its record for the signed-in AIHUB User Account. Idempotent: an account with no Avatar also answers `204`. If the image cannot be deleted the account keeps its Avatar and the call answers `503`; retrying finishes the removal. `409 AVATAR_CHANGED` means another request replaced the Avatar meanwhile, and the replacement is kept.',
      successDescription: 'The account has no Avatar.',
    },
    method: 'DELETE',
    timeoutMs: 10_000,
    path: '/v1/me/avatar',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 204,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: null,
    errorStatuses: [401, 409, 500, 503],
  },
} as const;

export const ME_PUBLIC_ROUTES = {
  'me.profile.read': {
    cacheControl: { value: 'no-store' },
    method: 'GET',
    path: '/v1/me',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ReadCurrentUserResponseSchema,
    errorStatuses: [401, 500, 503],
  },
} as const;

export const SANDBOX_PUBLIC_ROUTES = {
  'sandbox.assertions.mint': {
    method: 'POST',
    path: '/v1/sandbox/assertions',
    callerAuth: 'api-key',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: MintSandboxAssertionRequestSchema,
    responseSchema: MintSandboxAssertionResponseSchema,
    errorStatuses: 'all-except-idempotency-conflict',
  },
  'sandbox.demo-key.validate': {
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v1/sandbox/demo/api-keys/validate',
    callerAuth: 'bff-api-key',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: SandboxDemoKeyValidationRequestSchema,
    responseSchema: SandboxDemoKeyValidationResponseSchema,
    errorStatuses: [400, 401, 403, 429, 500, 503],
  },
} as const;
