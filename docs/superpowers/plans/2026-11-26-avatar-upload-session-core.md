# Avatar Upload Session Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Avatar upload create/complete/sweep onto `src/modules/uploads` with identical HTTP behavior, then report line counts on #2052.

**Architecture:** The core keeps the state machine and pagination. It gains four optional seams: owner from policy, a storage descriptor with `etag`/`lastModified`, `requestId` plus stored `contentType`/`byteSize` at publication, and a candidate-source port for sweep. Avatar supplies policy and adapters; its grant row becomes the durable session record under ADR-0197.

**Tech Stack:** NestJS, TypeScript, Bun/Jest, TypeBox contracts, Prisma repositories, S3/SeaweedFS adapters, `gh` CLI for issue comments.

## Global Constraints

- Package manager is Bun; run `bun run ...`, never `pnpm`.
- Hand-written source files are capped at 500 code lines (ADR-0110).
- Layer folders under `src/modules/` hold at most 20 direct entries; `avatar/application` currently has room but must not exceed it.
- Cross-module imports must end at a module file, application port, `public/` facade, or Nest export (`pnpm arch-check` / `bun run arch-check` enforces).
- All GitHub content is English; commit headers are Conventional Commits; `type(scope): subject`, max 100 chars.
- Never log API keys, signed assertions, internal JWTs, essay text, raw bodies, or raw downstream responses.
- Issue #2052 stays open until AC complete and production evidence exists.

---

### Task 1: Core seams for Avatar

**Files:**

- Modify: `src/modules/uploads/application/upload-session.port.ts`
- Modify: `src/modules/uploads/domain/upload-session.ts`
- Modify: `src/modules/uploads/application/upload-session.service.ts`
- Modify: `src/modules/uploads/application/upload-session.sweep.ts`
- Test: `src/modules/uploads/application/upload-session-extension.spec.ts`

**Interfaces:**

- Consumes: existing `UploadSessionService`, `UploadSessionSweep`.
- Produces: `inspectObject` result may carry `lastModified`/`etag`; `PublishedUploadSession.retentionExpiresAt` optional; `markPublished` accepts `requestId?`, `contentType?`, `byteSize?`; `UploadSessionSweep` 4th constructor arg is a candidate source.

- [ ] **Step 1: Write the failing test**

Create `src/modules/uploads/application/upload-session-extension.spec.ts`:

```ts
import { UploadSessionService } from "./upload-session.service";

const NOW = new Date("2026-11-26T00:00:00.000Z");
const ASSET = "ava_01J00000000000000000000001";

describe("UploadSessionService Avatar seams", () => {
  it("passes stored content type and byte size to publication", async () => {
    const stored = {
      contentType: "image/png",
      byteSize: 12,
      bytes: new Uint8Array(12),
      lastModified: NOW,
      etag: "etag-1",
    };
    const repository = {
      createIntent: jest.fn(async () => true),
      findUpload: jest.fn(async () => ({
        kind: "intent" as const,
        intent: {
          assetId: ASSET,
          endUserId: "usr_01J00000000000000000000000",
          environment: "production" as const,
          stagingKey: "users/u/avatar/a/original",
          publishedKey: "users/u/avatar/a/original",
          contentType: "image/jpeg",
          byteSize: 0,
          createdAt: NOW,
          expiresAt: new Date(NOW.getTime() + 300_000),
          status: "open" as const,
        },
      })),
      rejectIntent: jest.fn(async () => undefined),
      beginPublication: jest.fn(async () => "started" as const),
      markPublished: jest.fn(async () => undefined),
      releasePublication: jest.fn(async () => undefined),
      cleanupCandidates: jest.fn(async () => []),
      removeCleanupCandidate: jest.fn(async () => true),
    };
    const storage = {
      createUploadUrl: jest.fn(async () => ({
        url: "private",
        fields: {},
        expiresAt: new Date(NOW.getTime() + 300_000),
      })),
      inspectObject: jest.fn(async () => stored),
      publishObject: jest.fn(async () => undefined),
      publicUrl: jest.fn(() => "url"),
      deleteStagingObject: jest.fn(async () => undefined),
      deletePublishedObject: jest.fn(async () => undefined),
    };
    const policy = {
      maxBytes: 2 * 1024 * 1024,
      intentTtlMs: 300_000,
      rateWindowMs: 3_600_000,
      orphanGraceMs: 86_400_000,
      owner: jest.fn(() => ({
        assetId: ASSET,
        endUserId: "usr_01J00000000000000000000000",
        environment: "production" as const,
      })),
      isContentType: () => true,
      isAssetId: () => true,
      stagingKey: (owner: { assetId: string }) =>
        `users/u/avatar/${owner.assetId}/original`,
      publishedKey: (owner: { assetId: string }) =>
        `users/u/avatar/${owner.assetId}/original`,
      invalidStoredObject: () => undefined,
      reserveVerification: () => ({ release: () => undefined }),
      verify: async () => ({ kind: "sanitized" as const, bytes: stored.bytes }),
      invalidRequest: () => new Error("invalid") as never,
      payloadTooLarge: () => new Error("too large") as never,
      rateLimited: () => new Error("rate limited") as never,
      storageUnavailable: () => new Error("unavailable") as never,
      notFound: () => new Error("not found") as never,
    };
    const service = new UploadSessionService(
      repository,
      storage,
      policy as never,
      () => ASSET,
      () => NOW
    );

    await service.complete({
      context: {
        requestId: "req-1",
        receivedAt: NOW,
        deadlineAt: NOW,
        operationTimeoutMs: 20_000,
        userId: "usr_01J00000000000000000000000",
        scopes: [],
        signal: new AbortController().signal,
      },
      assetId: ASSET,
    });

    expect(repository.markPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        contentType: "image/png",
        byteSize: 12,
      })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- ./src/modules/uploads/application/upload-session-extension.spec.ts`
Expected: FAIL because `markPublished` does not receive `requestId`/`contentType`/`byteSize`.

- [ ] **Step 3: Apply core seam edits**

In `src/modules/uploads/application/upload-session.port.ts`, add optional descriptor fields to `inspectObject` result:

```ts
        readonly bytes: Uint8Array;
        readonly lastModified?: Date;
        readonly etag?: string;
```

Change `markPublished` input to:

```ts
  markPublished(input: {
    readonly owner: UploadSessionOwner;
    readonly now: Date;
    readonly publicationStartedAt: Date;
    readonly imageUrl: string;
    readonly requestId?: string;
    readonly contentType?: string;
    readonly byteSize?: number;
  }): Promise<PublishedUploadSession | 'revoked' | undefined>;
```

In `src/modules/uploads/domain/upload-session.ts`, change `retentionExpiresAt` to optional:

```ts
  readonly publishedAt: Date;
  readonly retentionExpiresAt?: Date;
  readonly imageUrl: string;
```

In `src/modules/uploads/application/upload-session.service.ts`, change verification input:

```ts
                contentType: stored.contentType ?? found.intent.contentType,
                bytes: stored.bytes,
```

Change `markPublished` call to:

```ts
            imageUrl,
            requestId: input.context.requestId,
            contentType: stored.contentType ?? found.intent.contentType,
            byteSize: stored.byteSize ?? found.intent.byteSize,
```

In `src/modules/uploads/application/upload-session.sweep.ts`, change the constructor parameter list:

```ts
  constructor(
    repository: Pick<
      UploadSessionRepositoryPort,
      'cleanupCandidates' | 'removeCleanupCandidate'
    >,
    private readonly storage: Pick<
      UploadSessionStoragePort,
      'deleteStagingObject' | 'deletePublishedObject'
    >,
    private readonly policy: Pick<UploadSessionPolicy, 'orphanGraceMs'>,
    private readonly deletionCeiling?: number,
    private readonly keysPerCandidate = 1,
    private readonly candidateSource: Pick<
      UploadSessionRepositoryPort,
      'cleanupCandidates' | 'removeCleanupCandidate'
    > = repository,
  ) {}
```

Replace the two sweep repository calls with `this.candidateSource.cleanupCandidates(...)` and `this.candidateSource.removeCleanupCandidate(candidate)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- ./src/modules/uploads/application/upload-session-extension.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/uploads/application/upload-session-extension.spec.ts src/modules/uploads/application/upload-session.port.ts src/modules/uploads/domain/upload-session.ts src/modules/uploads/application/upload-session.service.ts src/modules/uploads/application/upload-session.sweep.ts
git commit -m "refactor(uploads): add Avatar lifecycle seams"
```

---

### Task 2: Avatar upload session policy

**Files:**

- Create: `src/modules/avatar/application/avatar-upload-session.policy.ts`
- Test: `src/modules/avatar/application/avatar-upload-session.policy.spec.ts`

**Interfaces:**

- Consumes: `UploadSessionPolicy` from `@/modules/uploads/public`, Avatar domain constants and `sanitizeRasterImage`.
- Produces: `avatarUploadSessionPolicy()`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/avatar/application/avatar-upload-session.policy.spec.ts`:

```ts
import { avatarUploadSessionPolicy } from "./avatar-upload-session.policy";

const ASSET = "ava_01J00000000000000000000001";
const USER = "usr_01J00000000000000000000000";

describe("avatarUploadSessionPolicy", () => {
  it("derives a user-only owner and one Avatar object key", () => {
    const policy = avatarUploadSessionPolicy();
    const owner = policy.owner({ userId: USER } as never, ASSET);
    expect(owner).toMatchObject({ assetId: ASSET, endUserId: USER });
    expect(owner.organizationId).toBeUndefined();
    expect(policy.stagingKey(owner)).toBe(
      `users/${USER}/avatar/${ASSET}/original`
    );
    expect(policy.publishedKey(owner)).toBe(policy.stagingKey(owner));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- ./src/modules/avatar/application/avatar-upload-session.policy.spec.ts`
Expected: FAIL with "Cannot find module './avatar-upload-session.policy'".

- [ ] **Step 3: Write the policy**

Create `src/modules/avatar/application/avatar-upload-session.policy.ts`:

```ts
import { AppError } from "@/common/errors/app-error";
import { invalidRequest } from "@/common/errors/invalid-request";
import { uploadNotFound } from "@/common/errors/upload-errors";
import {
  type RasterImageProcessingAdmission,
  RasterImageProcessingAbortedError,
  RasterImageProcessingCapacityError,
  sanitizeRasterImage,
} from "@/common/image/raster-image";
import type { UploadSessionPolicy } from "@/modules/uploads/public";
import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_PIXELS,
  AVATAR_SWEEP_GRACE_MS,
  AVATAR_UPLOAD_URL_TTL_SECONDS,
  type AvatarContentType,
  avatarObjectKey,
  isAvatarAssetId,
  isAvatarContentType,
} from "@/modules/avatar/domain/avatar";
import {
  AVATAR_COMPLETION_DEADLINE_MS,
  AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
  reserveAvatarRasterImageProcessing,
} from "./avatar-upload.policy";

function rateLimited(): AppError {
  return new AppError({
    code: "RATE_LIMITED",
    message: "Avatar upload limit reached; retry later",
    retryable: true,
    retryAfterMs: AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
  });
}

function storageUnavailable(): AppError {
  return new AppError({
    code: "AVATAR_STORAGE_UNAVAILABLE",
    message: "Avatar storage is unavailable",
    retryable: true,
  });
}

function payloadTooLarge(): AppError {
  return new AppError({
    code: "PAYLOAD_TOO_LARGE",
    message: "Avatar image is larger than 2 MiB",
    retryable: false,
  });
}

export function avatarUploadSessionPolicy(): UploadSessionPolicy {
  return {
    maxBytes: AVATAR_MAX_BYTES,
    intentTtlMs: AVATAR_UPLOAD_URL_TTL_SECONDS * 1000,
    rateWindowMs: AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
    orphanGraceMs: AVATAR_SWEEP_GRACE_MS,
    completionSignal: (signal) =>
      AbortSignal.any([
        signal,
        AbortSignal.timeout(AVATAR_COMPLETION_DEADLINE_MS),
      ]),
    owner: (context, assetId) => {
      if (context.userId === undefined) throw storageUnavailable();
      return {
        assetId,
        endUserId: context.userId,
        environment: "production",
      };
    },
    isContentType: (value) => isAvatarContentType(value),
    isAssetId: (value) => isAvatarAssetId(value),
    stagingKey: (owner) => avatarObjectKey(owner.endUserId, owner.assetId),
    publishedKey: (owner) => avatarObjectKey(owner.endUserId, owner.assetId),
    reserveVerification: () => {
      try {
        return reserveAvatarRasterImageProcessing();
      } catch (error) {
        if (error instanceof RasterImageProcessingCapacityError) {
          throw new AppError({
            code: "RATE_LIMITED",
            message: "Avatar image processing is busy; retry later",
            retryable: true,
            retryAfterMs: 1_000,
          });
        }
        throw error;
      }
    },
    verify: async ({ contentType, bytes, lease }) => {
      try {
        return await sanitizeRasterImage({
          contentType: contentType as AvatarContentType,
          bytes,
          maxBytes: AVATAR_MAX_BYTES,
          maxPixels: AVATAR_MAX_PIXELS,
        });
      } catch (error) {
        if (error instanceof RasterImageProcessingAbortedError) {
          throw storageUnavailable();
        }
        throw error;
      } finally {
        (lease as RasterImageProcessingAdmission).release();
      }
    },
    invalidStoredObject: (stored) => {
      if (stored.byteSize !== undefined && stored.byteSize > AVATAR_MAX_BYTES) {
        return payloadTooLarge();
      }
      if (!isAvatarContentType(stored.contentType)) return invalidRequest();
      return undefined;
    },
    invalidRequest: () => invalidRequest(),
    payloadTooLarge: () => payloadTooLarge(),
    rateLimited: () => rateLimited(),
    storageUnavailable: () => storageUnavailable(),
    notFound: () => uploadNotFound("NOT_FOUND", "Avatar upload was not found"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- ./src/modules/avatar/application/avatar-upload-session.policy.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/avatar/application/avatar-upload-session.policy.ts src/modules/avatar/application/avatar-upload-session.policy.spec.ts
git commit -m "feat(avatar): add upload session policy"
```

---

### Task 3: Avatar repository, storage and sweep adapters

**Files:**

- Create: `src/modules/avatar/application/avatar-upload-session.adapters.ts`

**Interfaces:**

- Consumes: `AvatarRepositoryPort`, `AvatarStoragePort`, core repository/storage ports and `UploadSessionCleanupCandidate`.
- Produces: `AvatarCoreRepositoryAdapter`, `AvatarCoreStorageAdapter`, `AvatarCoreCandidateSource`.

- [ ] **Step 1: Write the adapter file**

Create `src/modules/avatar/application/avatar-upload-session.adapters.ts` with these exact rules:

```ts
import type { AppError } from "@/common/errors/app-error";
import { invalidRequest } from "@/common/errors/invalid-request";
import type {
  PublishedUploadSession,
  UploadSessionCleanupCandidate,
  UploadSessionIntent,
  UploadSessionLookup,
  UploadSessionOwner,
  UploadSessionRepositoryPort,
  UploadSessionStoragePort,
} from "@/modules/uploads/public";
import {
  AVATAR_COMPLETION_WINDOW_MS,
  AVATAR_SWEEP_GRACE_MS,
  AVATAR_UPLOAD_URL_TTL_SECONDS,
  type Avatar,
  type AvatarContentType,
  avatarObjectKey,
  isAvatarObjectKey,
} from "@/modules/avatar/domain/avatar";
import {
  AVATAR_OPEN_UPLOAD_MAX,
  AVATAR_UPLOAD_ISSUANCE_MAX,
  AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
} from "./avatar-upload.policy";
import type {
  AvatarAuditEvent,
  AvatarRepositoryPort,
} from "./avatar-repository.port";
import type {
  AvatarStoragePort,
  ListedAvatarObject,
} from "./avatar-storage.port";

function coreAsset(avatar: Avatar, created: boolean): PublishedUploadSession {
  return {
    assetId: avatar.assetId,
    endUserId: avatar.userId,
    environment: "production",
    stagingKey: avatar.objectKey,
    publishedKey: avatar.objectKey,
    contentType: avatar.contentType,
    byteSize: avatar.byteSize,
    createdAt: avatar.acceptedAt,
    expiresAt: avatar.acceptedAt,
    status: "published",
    publishedAt: avatar.acceptedAt,
    imageUrl: avatar.objectKey,
    created,
  };
}

function audit(
  action: AvatarAuditEvent["action"],
  assetId: string,
  requestId: string | undefined,
  occurredAt: Date
): AvatarAuditEvent {
  return { action, assetId, requestId: requestId ?? "", occurredAt };
}

type Gate =
  | {
      readonly kind: "accepted";
      readonly avatar: Avatar;
      readonly requestId: string | undefined;
    }
  | { readonly kind: "refused"; readonly refusal: AppError };
```

Implement `AvatarCoreRepositoryAdapter implements UploadSessionRepositoryPort`:

- Constructor: `(repository: AvatarRepositoryPort, now: () => Date = () => new Date())`.
- Private `gates: Map<string, { decide(result: Gate): void; result: Promise<{kind:'recorded'; avatar: Avatar; created: boolean} | {kind:'rejected'}> }>`.
- `createIntent(intent, rateWindowMs?)`: call `repository.grantUpload({userId: intent.endUserId, assetId: intent.assetId, objectKey: intent.stagingKey, expiresAt: intent.expiresAt, createdAt: intent.createdAt}, {openLimit: AVATAR_OPEN_UPLOAD_MAX, issuanceLimit: AVATAR_UPLOAD_ISSUANCE_MAX, issuanceWindowMs: rateWindowMs ?? AVATAR_UPLOAD_ISSUANCE_WINDOW_MS})`.
- `findUpload(owner)`: if `findByUser(userId)?.assetId === owner.assetId`, return `{kind:'asset', asset: coreAsset(current,false)}`; else find grant via `openUploadGrants(userId, this.now())`; if none return `{kind:'missing'}`; else return an intent with `contentType:'image/jpeg'`, `byteSize:0`, `createdAt: new Date(grant.expiresAt.getTime() - AVATAR_UPLOAD_URL_TTL_SECONDS*1000)`, `expiresAt: grant.expiresAt`, `status:'open'`, `stagingKey`/`publishedKey` from `avatarObjectKey`.
- `rejectIntent(owner)`: `consumeUploadGrant(owner.endUserId, owner.assetId)`.
- `beginPublication(input)`: first `findUpload`; `'published'` for asset, `'missing'` otherwise. Create a deferred `Gate`, then call `repository.withUserLock(userId, async (avatars) => { const prepared = await gate; if (prepared.kind === 'refused') return {kind:'rejected'}; const previous = await avatars.findByUser(userId); if (previous?.assetId === prepared.avatar.assetId) return {kind:'recorded', avatar: previous, created:false}; if (previous === undefined) { const recorded = await avatars.record(prepared.avatar, audit('avatar.set', prepared.avatar.assetId, prepared.requestId, input.now)); if (recorded.kind === 'exists') { const current = await avatars.findByUser(userId); if (current?.assetId !== prepared.avatar.assetId) throw avatarChanged(); return {kind:'recorded', avatar: current ?? prepared.avatar, created:false}; } return {kind:'recorded', avatar: recorded.avatar, created: recorded.kind === 'recorded'}; } const replaced = await avatars.replace(previous.assetId, prepared.avatar, audit('avatar.replaced', prepared.avatar.assetId, prepared.requestId, input.now)); if (!replaced) { const current = await avatars.findByUser(userId); if (current?.assetId !== prepared.avatar.assetId) throw avatarChanged(); return {kind:'recorded', avatar: current ?? previous, created:false}; } return {kind:'recorded', avatar: prepared.avatar, created:true}; })`. Store gate and return `'started'`. Define `avatarChanged()` in this file as an `AppError` with code `AVATAR_CHANGED`, message `The Avatar was changed by another request`, `retryable:false`.
- `markPublished(input)`: build `Avatar` from `input.owner.assetId`, `endUserId`, `input.contentType ?? 'image/jpeg'`, `input.byteSize ?? 0`, `acceptedAt: input.now`, `objectKey: avatarObjectKey(userId, assetId)`. Call `gate.decide({kind:'accepted', avatar, requestId: input.requestId})`, await `gate.result`, consume grant, return `coreAsset(result.avatar, result.created)` or `undefined` for rejected.
- `releasePublication(owner)`: decide refused with `invalidRequest()`, await result, delete gate.
- `cleanupCandidates()` returns `[]`; `removeCleanupCandidate()` returns `true` (object-store candidate source owns sweep).

Implement `AvatarCoreStorageAdapter implements UploadSessionStoragePort`:

- Constructor `(storage: AvatarStoragePort, now: () => Date = () => new Date())`.
- `createUploadUrl`: `storage.createUploadUrl({objectKey: input.stagingKey, contentType: input.contentType as AvatarContentType})`, return `{...signed, fields: {}}`.
- `inspectObject`: `describeStagingObject(input.stagingKey, signal)`; if older than `AVATAR_COMPLETION_WINDOW_MS`, return `undefined`; `readStagingObject(input.stagingKey, described.etag, signal)`; return `{contentType: staged.contentType ?? described.contentType, byteSize: described.byteSize ?? staged.bytes.byteLength, bytes: staged.bytes, ...(described.lastModified === undefined ? {} : {lastModified: described.lastModified}), ...(described.etag === undefined ? {} : {etag: described.etag})}`.
- `publishObject`: `storage.putFinalObject({objectKey: input.publishedKey, contentType: input.contentType as AvatarContentType, bytes: input.bytes, ...(signal === undefined ? {} : {signal})})`.
- `publicUrl`: `storage.publicUrl(input.publishedKey)`.
- `deleteStagingObject`: `storage.deleteStagingObject(input.stagingKey, signal)`.
- `deletePublishedObject`: `storage.deleteObject(input.publishedKey, signal)`.

Implement `AvatarCoreCandidateSource implements Pick<UploadSessionRepositoryPort,'cleanupCandidates'|'removeCleanupCandidate'>`:

- Constructor `(repository: AvatarRepositoryPort, storage: AvatarStoragePort)`.
- Private `startAfter: Map<string,string>`.
- `cleanupCandidates(input)`: collect `for await` of `storage.listObjects('users/', afterKey)` and `storage.listStagingObjects('users/', afterKey)` into `ListedAvatarObject[]`; dedupe by `objectKey`; skip keys failing `isAvatarObjectKey`; skip `lastModified > input.orphanBefore`; parse `userId = parts[1]`, `assetId = parts[3]`; skip if `repository.recordedObjectKeys([key])` has it; push candidate `{kind:'intent', assetId, environment:'production', stagingKey:key, publishedKey: avatarObjectKey(userId, assetId), createdAt: listed.lastModified ?? new Date(0)}`; store `startAfter`; stop at `input.limit`.
- `removeCleanupCandidate()` returns `true`.
- Export `AVATAR_SWEEP_ORPHAN_GRACE_MS = AVATAR_SWEEP_GRACE_MS`.

- [ ] **Step 2: Typecheck**

Run: `bun run type-check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/modules/avatar/application/avatar-upload-session.adapters.ts
git commit -m "feat(avatar): add shared-core adapters"
```

---

### Task 4: Avatar service, sweep wrapper and module wiring

**Files:**

- Modify: `src/modules/avatar/application/avatar-upload.service.ts`
- Modify: `src/modules/avatar/application/avatar-orphan-sweep.ts`
- Modify: `src/modules/avatar/avatar.module.ts`

**Interfaces:**

- Consumes: Task 2 policy, Task 3 adapters, core tokens `UPLOAD_SESSION_SERVICE`/`UPLOAD_SESSION_SWEEP`.
- Produces: `AvatarUploadService` with identical public methods; `AvatarOrphanSweep` with optional core.

- [ ] **Step 1: Rewrite `AvatarUploadService` public surface**

Keep `AvatarUpload`, `PublishedAvatar`, `CompletedAvatar` interfaces unchanged. Replace imports with:

```ts
import { AppError } from "@/common/errors/app-error";
import type { IdMinter } from "@/common/ids/prefixed-id";
import type { RequestContext } from "@/common/request-context/request-context";
import {
  UploadSessionService,
  type UploadSessionServicePort,
} from "@/modules/uploads/public";
import {
  type Avatar,
  type AvatarContentType,
  avatarObjectKey,
} from "@/modules/avatar/domain/avatar";
import type {
  AvatarAuditEvent,
  AvatarRepositoryPort,
} from "./avatar-repository.port";
import type { AvatarStoragePort } from "./avatar-storage.port";
import {
  AvatarCoreRepositoryAdapter,
  AvatarCoreStorageAdapter,
} from "./avatar-upload-session.adapters";
import { avatarUploadSessionPolicy } from "./avatar-upload-session.policy";
import { AVATAR_COMPLETION_DEADLINE_MS } from "./avatar-upload.policy";
```

Define `avatarChanged(): AppError` with code `AVATAR_CHANGED`.

Constructor, preserving old 4-arg test call shape:

```ts
  private readonly core: UploadSessionServicePort;
  private readonly now: () => Date;

  constructor(
    private readonly avatars: AvatarRepositoryPort,
    private readonly storage: AvatarStoragePort,
    coreOrIdMinter: UploadSessionServicePort | IdMinter,
    nowOrCore: (() => Date) | UploadSessionServicePort = () => new Date(),
  ) {
    if (typeof coreOrIdMinter !== 'function') {
      this.core = coreOrIdMinter;
      this.now = typeof nowOrCore === 'function' ? nowOrCore : () => new Date();
      return;
    }
    const now = nowOrCore as () => Date;
    const policy = avatarUploadSessionPolicy();
    this.core = new UploadSessionService(
      new AvatarCoreRepositoryAdapter(avatars, now),
      new AvatarCoreStorageAdapter(storage, now),
      policy,
      coreOrIdMinter,
      now,
    );
    this.now = now;
  }
```

`requestUpload`: call `core.create` with a `RequestContext` containing `userId`, `environment:'production'`, `scopes:[]`, `requestId:'avatar-upload'`, `signal:new AbortController().signal`; map grant to `AvatarUpload`.

`completeUpload`: build signal `AbortSignal.timeout(AVATAR_COMPLETION_DEADLINE_MS)` or `AbortSignal.any([input.signal, timeout])`; call `core.complete` with `requestId: input.requestId`; map to `Avatar` using `published.assetId`, `input.userId`, `avatarObjectKey(...)`, stored content type/byte size from `published`, `acceptedAt: published.publishedAt`, `created: published.created ?? false`.

Keep `readAvatar`, `removeAvatar`, `published`, `audit`, `discardIfUnrecorded` unchanged from current source.

- [ ] **Step 2: Delegate sweep pagination**

In `avatar-orphan-sweep.ts`, add `import type { UploadSessionSweep } from '@/modules/uploads/public';` and add optional third constructor arg `private readonly core?: UploadSessionSweep`. In `run(input)`, if `core` is defined, call `const summary = await this.core.run(input)` and map to `AvatarSweepSummary` (`orphaned: summary.eligible`, `ceilingExceeded: this.core.ceilingExceeded`, staging fields from summary). If `core` is undefined, keep the current `plan`-based body as the CLI fallback. Keep `runRecovery` unchanged.

- [ ] **Step 3: Wire the module**

In `avatar.module.ts`, remove `prefixedIdGenerator` only if still used by the new providers (keep it for the avatar ID minter). Add imports:

```ts
import {
  UPLOAD_SESSION_SERVICE,
  UPLOAD_SESSION_SWEEP,
  UploadSessionService,
  UploadSessionSweep,
  type UploadSessionServicePort,
} from "@/modules/uploads/public";
import {
  AvatarCoreCandidateSource,
  AvatarCoreRepositoryAdapter,
  AvatarCoreStorageAdapter,
} from "./application/avatar-upload-session.adapters";
import { avatarUploadSessionPolicy } from "./application/avatar-upload-session.policy";
```

Add providers: `UPLOAD_SESSION_SERVICE` factory builds `UploadSessionService(new AvatarCoreRepositoryAdapter(avatars), new AvatarCoreStorageAdapter(storage), avatarUploadSessionPolicy(), prefixedIdGenerator('ava_'))`; `UPLOAD_SESSION_SWEEP` factory builds `UploadSessionSweep(new AvatarCoreRepositoryAdapter(avatars), new AvatarCoreStorageAdapter(storage), policy, 2_000, 2, new AvatarCoreCandidateSource(avatars, storage))`. Inject `UPLOAD_SESSION_SERVICE` into `AvatarUploadService` and `UPLOAD_SESSION_SWEEP` into `AvatarOrphanSweep`. Keep `exports: [AvatarOrphanSweep]`.

- [ ] **Step 4: Run focused tests**

Run: `bun run test -- ./src/modules/avatar/application/avatar-upload-session.policy.spec.ts ./src/modules/avatar/application/avatar-upload.service.spec.ts ./src/modules/avatar/application/avatar-orphan-sweep.spec.ts ./src/modules/avatar/presentation/avatar.controller.spec.ts`
Expected: PASS with existing assertions unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/modules/avatar/application/avatar-upload.service.ts src/modules/avatar/application/avatar-orphan-sweep.ts src/modules/avatar/avatar.module.ts
git commit -m "refactor(avatar): use shared upload session core"
```

---

### Task 5: Gates, line count and issue comment

**Files:**

- Test: all changed specs via `bun run check:changed`
- Docs: issue #2052 comment (GitHub, not a repo file)

**Interfaces:**

- Consumes: completed migration.
- Produces: evidence comment on #2052.

- [ ] **Step 1: Run changed-file gates**

Run: `bun run check:changed`
Expected: PASS.

- [ ] **Step 2: Run full suite once**

Run: `bun run verify`
Expected: PASS. If a named suite fails, re-run it alone before drawing conclusions.

- [ ] **Step 3: Measure line counts**

Use non-spec `.ts` line counts (non-blank) under `src/modules/avatar` and `src/modules/writing/chart-uploads` against `origin/main`; record before/after and reduction for Avatar and Speaking.

- [ ] **Step 4: Comment on #2052**

Write the comment body to `temp/issue-2052-comment.md`, post with `gh issue comment 2052 --body-file temp/issue-2052-comment.md`, read it back with `gh api repos/AiHub-Ecosystem/aihub-be/issues/comments/<id> --jq .body`, then delete the temp file and `temp/` if empty. Include commit hashes, gates, line counts, and remaining production-evidence step.

- [ ] **Step 5: Commit any remaining doc changes and stop**

Do not close #677/#2052 without production evidence.
