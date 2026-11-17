import type { PrismaClient } from '@prisma-client/client';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import { PostgresSandboxDispatchBudget } from '@/modules/gateway/infrastructure/postgres-sandbox-dispatch-budget';
import { PostgresIdempotencyRepository } from '@/modules/idempotency/infrastructure/postgres-idempotency.repository';
import { PostgresApiKeyRepository } from '@/modules/identity/api-keys/infrastructure/postgres-api-key.repository';
import { PostgresOrganizationApiKeyRepository } from '@/modules/identity/api-keys/infrastructure/postgres-organization-api-key.repository';
import {
  auditStamp,
  recordOrganizationAuditDenial,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import { PostgresOrganizationAuditReadRepository } from '@/modules/identity/audit/infrastructure/postgres-organization-audit-read.repository';
import { PostgresOrganizationInvitationReadRepository } from '@/modules/identity/invitations/infrastructure/postgres-organization-invitation-read.repository';
import { PostgresOrganizationMembershipReadRepository } from '@/modules/identity/membership/infrastructure/postgres-organization-membership-read.repository';
import { PostgresOrganizationIdentityConfigRepository } from '@/modules/identity/organization-identity-configuration/infrastructure/postgres-organization-identity-config.repository';
import { PostgresDispatchAttemptRepository } from '@/modules/metering/infrastructure/usage-recording/postgres-dispatch-attempt.repository';
import { PostgresUsageRepository } from '@/modules/metering/infrastructure/usage-recording/postgres-usage.repository';
import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { PostgresSpeakingGradingJobRepository } from '@/modules/speaking/infrastructure/grading-jobs/postgres-speaking-grading-job.repository';
import { PostgresSpeakingAudioUploadRepository } from '@/modules/speaking/infrastructure/postgres-speaking-audio-upload.repository';
import { PostgresWritingChartUploadRepository } from '@/modules/writing/chart-uploads/infrastructure/postgres-writing-chart-upload.repository';

/**
 * #785 / ADR-0109: a request-serving repository method that touches an
 * Organization-owned table runs every statement inside the Organization seam.
 * Each covered method is driven against a scripted client, and the spec fails
 * if a statement runs outside a transaction or a transaction's first statement
 * is not the Organization setting. Every method of a listed class must be
 * classified here, so a new method that skips the seam cannot go unnoticed.
 */
const ORG = 'org_seam_probe';
const NOW = new Date('2026-11-16T12:00:00.000Z');

const context = createRequestContext({
  requestId: 'req_01J00000000000000000000000',
  receivedAt: NOW,
  deadlineMs: 5_000,
  userId: 'usr_actor',
  organizationId: ORG,
  scopes: [],
});

const speakingIntent = {
  assetId: 'aud_01J00000000000000000000001',
  organizationId: ORG,
  endUserId: 'learner-42',
  environment: 'production' as const,
  objectKey: `orgs/${ORG}/speaking/aud_01J00000000000000000000001/original`,
  contentType: 'audio/wav' as const,
  byteSize: 1_024,
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  status: 'open' as const,
};
const speakingOwner = {
  assetId: speakingIntent.assetId,
  organizationId: ORG,
  endUserId: speakingIntent.endUserId,
  environment: speakingIntent.environment,
};
const chartIntent = {
  assetId: 'chart_01J00000000000000000000001',
  organizationId: ORG,
  endUserId: 'learner-42',
  environment: 'production' as const,
  stagingKey: 'writing-charts/chart_01J00000000000000000000001/staging',
  publishedKey: 'writing-charts/chart_01J00000000000000000000001/published',
  contentType: 'image/png' as const,
  byteSize: 1,
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  status: 'open' as const,
};
const chartOwner = {
  assetId: chartIntent.assetId,
  organizationId: ORG,
  endUserId: chartIntent.endUserId,
  environment: chartIntent.environment,
};
const gradingJob = {
  jobId: 'sgj_01J00000000000000000000001',
  organizationId: ORG,
  endUserId: 'learner-42',
  environment: 'production' as const,
  identityMode: 'signed_assertion' as const,
  apiKeyId: 'key_01J00000000000000000000001',
  maxConcurrent: 3,
  quotaTracked: true,
  quotaUnverified: false,
  idempotencyKey: 'idem-1',
  audioAssetId: 'aud_01J00000000000000000000001',
  request: { part: 1 as const, questionId: 'question-1' },
  createdAt: NOW,
};
const idempotencyKey = {
  organizationId: ORG,
  operation: 'writing.task1.grade' as const,
  actorScope: '',
  idempotencyKey: 'grade-1',
  requestId: 'req_1',
};
const gradingOwner = {
  organizationId: ORG,
  endUserId: gradingJob.endUserId,
  environment: gradingJob.environment,
};

interface Group {
  readonly name: string;
  readonly prototype: object;
  /** Request-serving methods: each must run entirely inside the seam. */
  readonly scoped: Readonly<Record<string, (client: PrismaClient) => unknown>>;
  /** Methods that deliberately stay off the seam, each with its reason. */
  readonly unscoped: Readonly<Record<string, string>>;
}

const LIFECYCLE = 'client lifecycle, no Organization data';
const SWEEP = 'fleet-wide sweep or worker, runs across Organizations';
const HELPER = 'private helper, reached only through a classified method';

const groups: readonly Group[] = [
  {
    name: 'PostgresUsageRepository',
    prototype: PostgresUsageRepository.prototype,
    scoped: {
      insert: (client) =>
        new PostgresUsageRepository(client as never).insert({
          requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
          organizationId: ORG,
          apiKeyId: 'ak_backend',
          actorId: 'student_123',
          service: 'writing',
          operation: 'writing.task1.grade',
          environment: 'production',
          outcome: 'success',
          httpStatus: 200,
          billableRequests: 1,
          meteringStatus: 'complete',
          totalMs: 100,
          billingBasis: 'response',
        } as never),
    },
    unscoped: { close: LIFECYCLE, onModuleDestroy: LIFECYCLE },
  },
  {
    name: 'PostgresDispatchAttemptRepository',
    prototype: PostgresDispatchAttemptRepository.prototype,
    scoped: {
      beginAttempt: (client) =>
        new PostgresDispatchAttemptRepository(client as never).beginAttempt({
          requestId: 'req-1',
          organizationId: ORG,
          operation: 'writing.task1.grade',
          operationTimeoutMs: 60_000,
        } as never),
      recordOutcome: (client) =>
        new PostgresDispatchAttemptRepository(client as never).recordOutcome(
          ORG,
          'attempt-1',
          'response_received',
        ),
    },
    unscoped: {
      getUnresolvedByOperation: 'fleet-wide metric, no Organization',
      close: LIFECYCLE,
      onModuleDestroy: LIFECYCLE,
    },
  },
  {
    name: 'PostgresSandboxDispatchBudget',
    prototype: PostgresSandboxDispatchBudget.prototype,
    scoped: {
      reserve: (client) =>
        new PostgresSandboxDispatchBudget(client as never).reserve({
          organizationId: ORG,
          requestId: 'req_1',
        }),
      release: (client) =>
        new PostgresSandboxDispatchBudget(client as never).release(
          ORG,
          'req_1',
        ),
      allowanceFor: (client) =>
        new PostgresSandboxDispatchBudget(client as never).allowanceFor(ORG),
    },
    unscoped: { onModuleDestroy: LIFECYCLE },
  },
  {
    name: 'PostgresSpeakingAudioUploadRepository',
    prototype: PostgresSpeakingAudioUploadRepository.prototype,
    scoped: {
      createIntent: (client) =>
        new PostgresSpeakingAudioUploadRepository(client).createIntent(
          speakingIntent,
        ),
      createIntentWithinCeiling: (client) =>
        new PostgresSpeakingAudioUploadRepository(
          client,
        ).createIntentWithinCeiling({
          intent: speakingIntent,
          decide: () => ({ kind: 'within' }),
        }),
      findUpload: (client) =>
        new PostgresSpeakingAudioUploadRepository(client).findUpload(
          speakingOwner,
        ),
      confirmRefreshableIntent: (client) =>
        new PostgresSpeakingAudioUploadRepository(
          client,
        ).confirmRefreshableIntent({ owner: speakingOwner, now: NOW }),
      removeRejectedIntent: (client) =>
        new PostgresSpeakingAudioUploadRepository(client).removeRejectedIntent(
          speakingOwner,
        ),
      completeIntent: (client) =>
        new PostgresSpeakingAudioUploadRepository(client).completeIntent({
          owner: speakingOwner,
          now: () => NOW,
          prepare: async () => {
            throw new Error('not reached by the scripted client');
          },
        }),
    },
    unscoped: {
      listCleanupCandidates: SWEEP,
      removeCleanupCandidate: SWEEP,
      findAsset: HELPER,
      transaction: HELPER,
      completionTransaction: HELPER,
      run: HELPER,
    },
  },
  {
    name: 'PostgresWritingChartUploadRepository',
    prototype: PostgresWritingChartUploadRepository.prototype,
    scoped: {
      createIntent: (client) =>
        new PostgresWritingChartUploadRepository(client).createIntent(
          chartIntent,
        ),
      findUpload: (client) =>
        new PostgresWritingChartUploadRepository(client).findUpload(chartOwner),
      rejectIntent: (client) =>
        new PostgresWritingChartUploadRepository(client).rejectIntent(
          chartOwner,
          NOW,
        ),
      beginPublication: (client) =>
        new PostgresWritingChartUploadRepository(client).beginPublication({
          owner: chartOwner,
          now: NOW,
        }),
      markPublished: (client) =>
        new PostgresWritingChartUploadRepository(client).markPublished({
          owner: chartOwner,
          now: NOW,
          publicationStartedAt: NOW,
          imageUrl: 'https://example.test/chart.png',
        }),
      releasePublication: (client) =>
        new PostgresWritingChartUploadRepository(client).releasePublication(
          chartOwner,
          NOW,
        ),
    },
    unscoped: {
      cleanupCandidates: SWEEP,
      removeCleanupCandidate: SWEEP,
      lock: HELPER,
      transaction: HELPER,
      run: HELPER,
    },
  },
  {
    name: 'PostgresSpeakingGradingJobRepository',
    prototype: PostgresSpeakingGradingJobRepository.prototype,
    scoped: {
      create: (client) =>
        new PostgresSpeakingGradingJobRepository(client).create(gradingJob),
      createWithAdmission: (client) =>
        new PostgresSpeakingGradingJobRepository(client).createWithAdmission({
          job: gradingJob,
          monthlyQuota: 5,
          admit: async () => true,
        }),
      findOwned: (client) =>
        new PostgresSpeakingGradingJobRepository(client).findOwned(
          gradingOwner,
          gradingJob.jobId,
        ),
      findByIdempotencyKey: (client) =>
        new PostgresSpeakingGradingJobRepository(client).findByIdempotencyKey({
          organizationId: ORG,
          endUserId: gradingJob.endUserId,
          idempotencyKey: 'idem-1',
        }),
      countInFlight: (client) =>
        new PostgresSpeakingGradingJobRepository(client).countInFlight({
          organizationId: ORG,
          environment: 'production',
        }),
    },
    unscoped: {
      claim: SWEEP,
      returnToQueue: SWEEP,
      markDispatchStarted: SWEEP,
      succeed: SWEEP,
      releaseQuotaReservation: SWEEP,
      fail: SWEEP,
      listStaleQueued: SWEEP,
      releaseExpiredLeases: SWEEP,
      interruptStaleDispatches: SWEEP,
      expireQueued: SWEEP,
      releaseSettledQuotaReservations: SWEEP,
      deleteCreatedBefore: SWEEP,
      scoped: HELPER,
      run: HELPER,
    },
  },
  {
    name: 'PostgresIdempotencyRepository',
    prototype: PostgresIdempotencyRepository.prototype,
    scoped: {
      reserve: (client) =>
        new PostgresIdempotencyRepository(client).reserve({
          ...idempotencyKey,
          fingerprintHex: 'a'.repeat(64),
          expiresAt: new Date(NOW.getTime() + 3_600_000),
        }),
      findCompletedMatch: (client) =>
        new PostgresIdempotencyRepository(client).findCompletedMatch({
          organizationId: ORG,
          operation: idempotencyKey.operation,
          actorScope: '',
          idempotencyKey: idempotencyKey.idempotencyKey,
          fingerprintHex: 'a'.repeat(64),
        }),
      complete: (client) =>
        new PostgresIdempotencyRepository(client).complete({
          ...idempotencyKey,
          responseStatus: 200,
          responseBody: {},
        }),
      markFailed: (client) =>
        new PostgresIdempotencyRepository(client).markFailed(idempotencyKey),
      delete: (client) =>
        new PostgresIdempotencyRepository(client).delete(idempotencyKey),
    },
    unscoped: {
      cleanupExpired: SWEEP,
      scoped: HELPER,
    },
  },
  {
    name: 'PostgresApiKeyRepository',
    prototype: PostgresApiKeyRepository.prototype,
    scoped: {
      touchLastUsed: (client) =>
        new PostgresApiKeyRepository(client).touchLastUsed(
          ORG,
          'key_01J00000000000000000000001',
          NOW,
        ),
    },
    unscoped: {
      findByHash: 'pre-tenant lookup by key hash (ADR-0109 decision 6)',
      lookup: HELPER,
    },
  },
  {
    name: 'PostgresOrganizationApiKeyRepository',
    prototype: PostgresOrganizationApiKeyRepository.prototype,
    scoped: {
      listApiKeys: (client) =>
        new PostgresOrganizationApiKeyRepository(client).listApiKeys({
          context,
          organizationId: ORG,
        }),
      createApiKey: (client) =>
        new PostgresOrganizationApiKeyRepository(client).createApiKey({
          context,
          organizationId: ORG,
          actorUserId: 'usr_actor',
          apiKeyId: 'key_01J00000000000000000000000',
          keyHash: 'a'.repeat(64),
          keyPrefix: 'aik_test',
          name: 'Test key',
          scopes: ['ai-writing:grade'],
          allowedEnvironments: ['production'],
          expiresAt: null,
          requiredEntitlements: ['writing'],
          activeKeyLimit: 5,
        }),
      rotateApiKey: (client) =>
        new PostgresOrganizationApiKeyRepository(client).rotateApiKey({
          context,
          organizationId: ORG,
          actorUserId: 'usr_actor',
          apiKeyId: 'key_01J00000000000000000000000',
          replacementId: 'key_01J00000000000000000000001',
          keyHash: 'b'.repeat(64),
          keyPrefix: 'aik_next',
          retiredAllowedEnvironments: ['production'],
          replacementAllowedEnvironments: ['production'],
          rotatedByUsername: 'rotator',
          now: NOW,
        }),
      revokeApiKey: (client) =>
        new PostgresOrganizationApiKeyRepository(client).revokeApiKey({
          context,
          organizationId: ORG,
          actorUserId: 'usr_actor',
          apiKeyId: 'key_01J00000000000000000000000',
          now: NOW,
        }),
    },
    unscoped: {
      scoped: HELPER,
      callerRefusal: HELPER,
      lockOrganizationAndAuthorize: HELPER,
    },
  },
  {
    name: 'PostgresOrganizationAuditReadRepository',
    prototype: PostgresOrganizationAuditReadRepository.prototype,
    scoped: {
      listAuditEvents: (client) =>
        new PostgresOrganizationAuditReadRepository(client).listAuditEvents({
          context,
          userId: 'usr_actor',
          organizationId: ORG,
          limit: 10,
          filter: {},
        } as never),
    },
    unscoped: {},
  },
  {
    name: 'PostgresOrganizationInvitationReadRepository',
    prototype: PostgresOrganizationInvitationReadRepository.prototype,
    scoped: {
      listOpenInvitations: (client) =>
        new PostgresOrganizationInvitationReadRepository(
          client,
        ).listOpenInvitations({
          context,
          userId: 'usr_actor',
          organizationId: ORG,
          now: NOW,
          limit: 100,
        }),
    },
    unscoped: {},
  },
  {
    name: 'PostgresOrganizationMembershipReadRepository',
    prototype: PostgresOrganizationMembershipReadRepository.prototype,
    scoped: {
      resolveMembership: (client) =>
        new PostgresOrganizationMembershipReadRepository(
          client,
        ).resolveMembership({
          context,
          userId: 'usr_actor',
          organizationId: ORG,
        }),
      listOrganizationMembers: (client) =>
        new PostgresOrganizationMembershipReadRepository(
          client,
        ).listOrganizationMembers({
          context,
          userId: 'usr_actor',
          organizationId: ORG,
          status: 'active',
          limit: 10,
        }),
    },
    unscoped: {
      listRoster:
        'pre-tenant: lists one User Account across Organizations (ADR-0109 decision 6)',
    },
  },
  {
    name: 'PostgresOrganizationIdentityConfigRepository',
    prototype: PostgresOrganizationIdentityConfigRepository.prototype,
    scoped: {
      findActiveByOrganizationId: (client) =>
        new PostgresOrganizationIdentityConfigRepository(
          client,
        ).findActiveByOrganizationId(ORG),
      findByOrganizationId: (client) =>
        new PostgresOrganizationIdentityConfigRepository(
          client,
        ).findByOrganizationId(ORG),
      saveForOwner: (client) =>
        new PostgresOrganizationIdentityConfigRepository(client).saveForOwner({
          context,
          userId: 'usr_actor',
          organizationId: ORG,
          issuer: 'https://issuer.example.test',
          jwksUrl: 'https://issuer.example.test/jwks.json',
          publicKeysJwks: null,
          allowedAlgorithms: ['RS256'],
          maxAssertionTtlSeconds: 300,
          sourceKind: 'url',
          keyThumbprints: [],
        }),
    },
    unscoped: { firstRow: HELPER },
  },
];

function methodNames(prototype: object): string[] {
  return Object.getOwnPropertyNames(prototype).filter(
    (name) => name !== 'constructor',
  );
}

describe('Organization seam coverage (#785, ADR-0109)', () => {
  it.each(groups.map((group) => [group.name, group] as const))(
    '%s classifies every method',
    (_name, group) => {
      const classified = new Set([
        ...Object.keys(group.scoped),
        ...Object.keys(group.unscoped),
      ]);
      const unclassified = methodNames(group.prototype).filter(
        (name) => !classified.has(name),
      );
      expect(unclassified).toEqual([]);
    },
  );

  const cases = groups.flatMap((group) =>
    Object.entries(group.scoped).map(
      ([method, run]) => [`${group.name}.${method}`, run] as const,
    ),
  );

  it.each(cases)('%s runs inside the Organization seam', async (_name, run) => {
    const prisma = new ScriptedPrisma();
    await Promise.resolve(run(prisma.client())).catch(() => undefined);
    expect(seamViolations(prisma)).toEqual([]);
  });

  it('recordOrganizationAuditDenial runs inside the Organization seam', async () => {
    const prisma = new ScriptedPrisma();
    await recordOrganizationAuditDenial(
      prisma.client(),
      auditStamp({ context, organizationId: ORG }, 'usr_actor', NOW),
      {
        action: 'organization.renamed',
        organizationId: ORG,
        name: 'Acme Learning',
        denial: 'insufficient_authority',
      },
    );
    expect(seamViolations(prisma)).toEqual([]);
  });
});

/** What a covered method did outside the seam; empty means it stayed inside. */
function seamViolations(prisma: ScriptedPrisma): string[] {
  const violations: string[] = [];
  // A method that failed before any statement would pass vacuously.
  if (prisma.statements.length === 0) violations.push('ran no statement');
  for (const statement of prisma.statements) {
    if (statement.transaction === 0) {
      violations.push(`outside a transaction: ${statement.name}`);
    }
  }
  const transactions = new Set(
    prisma.statements
      .map(({ transaction }) => transaction)
      .filter((transaction) => transaction !== 0),
  );
  for (const transaction of transactions) {
    const first = prisma.statements.find(
      (statement) => statement.transaction === transaction,
    );
    const declared =
      first?.name === 'SELECT set_config($1, $2, true)' &&
      first.args[0] === 'aihub.organization_id' &&
      first.args[1] === ORG;
    if (!declared) {
      violations.push(
        `transaction ${transaction} does not open with the Organization setting`,
      );
    }
  }
  return violations;
}
