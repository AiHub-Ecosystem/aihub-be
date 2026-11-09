import { ulid } from 'ulid';

import type { SpeakingV2QuestionResult } from '@/contracts/speaking/v2/question-result';
import { createFixturePrismaClient } from '@/modules/persistence/persistence.module';
import type { NewSpeakingGradingJob } from '@/modules/speaking/application/grading-jobs/speaking-grading-job';
import { PostgresSpeakingGradingJobRepository } from '@/modules/speaking/infrastructure/grading-jobs/postgres-speaking-grading-job.repository';
import { testDatabaseUrl } from '../shared/database';

const client = createFixturePrismaClient(testDatabaseUrl());
const repository = new PostgresSpeakingGradingJobRepository(client);
const NOW = new Date('2026-11-08T12:00:00.000Z');

function makeJob(
  overrides: Partial<NewSpeakingGradingJob> = {},
): NewSpeakingGradingJob {
  const defaults: NewSpeakingGradingJob = {
    jobId: 'sgj_' + ulid(),
    organizationId: 'org_' + ulid(),
    endUserId: 'learner-1',
    environment: 'production',
    identityMode: 'signed_assertion',
    apiKeyId: 'key_' + ulid(),
    maxConcurrent: 3,
    quotaTracked: true,
    quotaUnverified: false,
    audioAssetId: 'aud_' + ulid(),
    request: {
      part: 1,
      questionId: 'question-1',
      promptText: 'Describe a place.',
      testType: 'practice',
      testCode: 'practice-1',
      partResultId: 'part-result-1',
    },
    createdAt: NOW,
  };
  return {
    ...defaults,
    ...overrides,
    request: { ...defaults.request, ...overrides.request },
  };
}

function owner(job: NewSpeakingGradingJob) {
  return {
    organizationId: job.organizationId,
    endUserId: job.endUserId,
    environment: job.environment,
  };
}

const RESULT: SpeakingV2QuestionResult = {
  meta: {
    schema_version: '2.4',
    result_type: 'question_result',
    test_id: null,
    test_type: 'practice',
    part: 1,
    question_id: 'question-1',
    response_id: 'response-1',
    part_result_id: null,
    graded_at: '2026-11-08T12:00:00.000Z',
  },
  transcript: {
    text: '',
    stats: { word_count: 0, speaking_seconds: 0 },
    tokens: [],
  },
  scores: {
    overall: 0,
    fluency_coherence: 0,
    lexical_resource: 0,
    grammatical_range_accuracy: 0,
    pronunciation: 0,
    is_provisional: true,
  },
  overall_feedback: { overview_vi: '', details: [] },
  criteria: {
    fluency_coherence: {
      summary: {
        reason_for_band_vi: '',
        strengths_vi: [],
        areas_for_improvement_vi: [],
      },
      diagnostics: null,
    },
    lexical_resource: {
      summary: {
        reason_for_band_vi: '',
        strengths_vi: [],
        areas_for_improvement_vi: [],
      },
      diagnostics: null,
    },
    grammatical_range_accuracy: {
      summary: {
        reason_for_band_vi: '',
        strengths_vi: [],
        areas_for_improvement_vi: [],
      },
      diagnostics: null,
    },
    pronunciation: {
      summary: {
        reason_for_band_vi: '',
        strengths_vi: [],
        areas_for_improvement_vi: [],
      },
      diagnostics: null,
    },
  },
};

describe('Speaking grading job repository in PostgreSQL', () => {
  afterAll(async () => client.close());

  it('creates and returns a job only to its Organization, End-User ID and Environment', async () => {
    const job = makeJob();
    await repository.create(job);

    await expect(
      repository.findOwned(owner(job), job.jobId),
    ).resolves.toMatchObject({
      ...job,
      status: 'queued',
    });
    await expect(
      repository.findOwned(
        { ...owner(job), organizationId: 'org_' + ulid() },
        job.jobId,
      ),
    ).resolves.toBeUndefined();
  });

  it('allows exactly one concurrent claim and refuses a job past its queue deadline', async () => {
    const job = makeJob();
    await repository.create(job);

    const claims = await Promise.all([
      repository.claim({
        jobId: job.jobId,
        now: NOW,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        expireBefore: new Date(NOW.getTime() - 1),
      }),
      repository.claim({
        jobId: job.jobId,
        now: NOW,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        expireBefore: new Date(NOW.getTime() - 1),
      }),
    ]);

    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(claims.find((claim) => claim !== undefined)).toMatchObject({
      status: 'running',
      maxConcurrent: 3,
    });

    const expired = makeJob({
      createdAt: new Date(NOW.getTime() - 16 * 60_000),
    });
    await repository.create(expired);
    await expect(
      repository.claim({
        jobId: expired.jobId,
        now: NOW,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        expireBefore: new Date(NOW.getTime() - 15 * 60_000),
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.findOwned(owner(expired), expired.jobId),
    ).resolves.toMatchObject({ status: 'queued' });
  });

  it('returns an unmarked running job to the queue and marks dispatch once', async () => {
    const job = makeJob();
    await repository.create(job);
    await repository.claim({
      jobId: job.jobId,
      now: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      expireBefore: new Date(NOW.getTime() - 15 * 60_000),
    });

    await expect(repository.returnToQueue(job.jobId)).resolves.toBe(true);
    await expect(repository.markDispatchStarted(job.jobId, NOW)).resolves.toBe(
      false,
    );
    await repository.claim({
      jobId: job.jobId,
      now: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      expireBefore: new Date(NOW.getTime() - 15 * 60_000),
    });
    await expect(repository.markDispatchStarted(job.jobId, NOW)).resolves.toBe(
      true,
    );
    await expect(repository.markDispatchStarted(job.jobId, NOW)).resolves.toBe(
      false,
    );
    await expect(repository.returnToQueue(job.jobId)).resolves.toBe(false);
  });

  it('lists stale queued jobs and releases expired pre-dispatch leases', async () => {
    const stale = makeJob({
      createdAt: new Date(NOW.getTime() - 120_000),
      environment: 'sandbox',
    });
    await repository.create(stale);
    await expect(
      repository.listStaleQueued({ createdBefore: NOW, limit: 100 }),
    ).resolves.toContainEqual({
      jobId: stale.jobId,
      environment: 'sandbox',
    });

    const leased = makeJob();
    await repository.create(leased);
    await repository.claim({
      jobId: leased.jobId,
      now: NOW,
      leaseExpiresAt: new Date(NOW.getTime() - 1),
      expireBefore: new Date(NOW.getTime() - 15 * 60_000),
    });
    await expect(repository.releaseExpiredLeases(NOW)).resolves.toContainEqual({
      jobId: leased.jobId,
      environment: 'production',
    });
    const requeued = await repository.findOwned(owner(leased), leased.jobId);
    expect(requeued).toMatchObject({ status: 'queued' });
    expect(requeued).not.toHaveProperty('leaseExpiresAt');
  });

  it('interrupts dispatched jobs and expires queued jobs in one sweep update each', async () => {
    const dispatched = makeJob();
    await repository.create(dispatched);
    await repository.claim({
      jobId: dispatched.jobId,
      now: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      expireBefore: new Date(NOW.getTime() - 15 * 60_000),
    });
    await repository.markDispatchStarted(
      dispatched.jobId,
      new Date(NOW.getTime() - 60_000),
    );
    const error = {
      code: 'DISPATCH_INTERRUPTED',
      message: 'The grading dispatch was interrupted.',
      retryable: true,
    };
    await expect(
      repository.interruptStaleDispatches({
        startedBefore: NOW,
        error,
        completedAt: NOW,
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        jobId: dispatched.jobId,
        status: 'failed',
        error,
      }),
    );

    const queued = makeJob({ createdAt: new Date(NOW.getTime() - 900_000) });
    await repository.create(queued);
    await expect(
      repository.expireQueued({
        createdBefore: NOW,
        error: {
          code: 'JOB_EXPIRED',
          message: 'Job expired.',
          retryable: true,
        },
        completedAt: NOW,
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        jobId: queued.jobId,
        status: 'failed',
        error: {
          code: 'JOB_EXPIRED',
          message: 'Job expired.',
          retryable: true,
        },
      }),
    );
  });

  it('counts queued and running jobs only for the requested Organization, Environment and date', async () => {
    const organizationId = 'org_' + ulid();
    const since = new Date(NOW.getTime() - 60_000);
    const queued = makeJob({ organizationId, createdAt: NOW });
    const running = makeJob({ organizationId, createdAt: NOW });
    const terminal = makeJob({ organizationId, createdAt: NOW });
    const sandbox = makeJob({
      organizationId,
      environment: 'sandbox',
      createdAt: NOW,
    });
    const otherOrganization = makeJob({ createdAt: NOW });
    const old = makeJob({
      organizationId,
      createdAt: new Date(since.getTime() - 1),
    });

    for (const job of [
      queued,
      running,
      terminal,
      sandbox,
      otherOrganization,
      old,
    ]) {
      await repository.create(job);
    }
    await repository.claim({
      jobId: running.jobId,
      now: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      expireBefore: new Date(NOW.getTime() - 15 * 60_000),
    });
    await repository.fail({
      jobId: terminal.jobId,
      error: { code: 'JOB_EXPIRED', message: 'Job expired.', retryable: true },
      completedAt: NOW,
    });

    await expect(
      repository.countInFlight({
        organizationId,
        environment: 'production',
        since,
      }),
    ).resolves.toBe(2);
  });

  it('serializes concurrent admission against monthly in-flight quota', async () => {
    const organizationId = 'org_' + ulid();
    const jobs = [makeJob({ organizationId }), makeJob({ organizationId })];
    const since = new Date('2026-11-01T00:00:00.000Z');

    const results = await Promise.all(
      jobs.map((job) =>
        repository.createWithAdmission({
          job,
          since,
          monthlyQuota: 1,
          admit: async (monthlyQuota) =>
            monthlyQuota !== null && monthlyQuota > 0,
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    await expect(
      repository.countInFlight({
        organizationId,
        environment: 'production',
        since,
      }),
    ).resolves.toBe(1);
  });

  it('recovers an existing job on duplicate idempotency key admission', async () => {
    const organizationId = 'org_' + ulid();
    const idempotencyKey = 'key_' + ulid();
    const firstJob = makeJob({ organizationId, idempotencyKey });
    const since = new Date('2026-11-01T00:00:00.000Z');

    const first = await repository.createWithAdmission({
      job: firstJob,
      since,
      monthlyQuota: 10,
      admit: async () => true,
    });
    expect(first).toEqual({ created: true });

    const duplicateJob = makeJob({ organizationId, idempotencyKey });
    const second = await repository.createWithAdmission({
      job: duplicateJob,
      since,
      monthlyQuota: 10,
      admit: async () => true,
    });
    expect(second).toEqual({ created: false, existingJobId: firstJob.jobId });

    await expect(
      repository.findByIdempotencyKey({
        organizationId,
        endUserId: firstJob.endUserId,
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ jobId: firstJob.jobId });
  });

  it('creates a new job when the idempotency key binding is past 24 hours', async () => {
    const organizationId = 'org_' + ulid();
    const idempotencyKey = 'key_' + ulid();
    const firstCreatedAt = new Date('2026-11-01T00:00:00.000Z');
    const firstJob = makeJob({
      organizationId,
      idempotencyKey,
      createdAt: firstCreatedAt,
    });
    const since = new Date('2026-11-01T00:00:00.000Z');

    const first = await repository.createWithAdmission({
      job: firstJob,
      since,
      monthlyQuota: 10,
      admit: async () => true,
    });
    expect(first).toEqual({ created: true });

    const secondCreatedAt = new Date('2026-11-02T01:00:00.000Z'); // 25 hours later
    const secondJob = makeJob({
      organizationId,
      idempotencyKey,
      createdAt: secondCreatedAt,
    });
    const second = await repository.createWithAdmission({
      job: secondJob,
      since,
      monthlyQuota: 10,
      admit: async () => true,
    });
    expect(second).toEqual({ created: true });

    await expect(
      repository.findByIdempotencyKey({
        organizationId,
        endUserId: secondJob.endUserId,
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ jobId: secondJob.jobId });
  });

  it('stores a successful result and refuses to fail a terminal job', async () => {
    const job = makeJob();
    await repository.create(job);
    await repository.claim({
      jobId: job.jobId,
      now: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      expireBefore: new Date(NOW.getTime() - 15 * 60_000),
    });

    await expect(
      repository.succeed({
        jobId: job.jobId,
        result: RESULT,
        completedAt: NOW,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.fail({
        jobId: job.jobId,
        error: {
          code: 'JOB_EXPIRED',
          message: 'Job expired.',
          retryable: true,
        },
        completedAt: NOW,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.findOwned(owner(job), job.jobId),
    ).resolves.toMatchObject({
      identityMode: 'signed_assertion',
      status: 'succeeded',
      result: RESULT,
    });
  });

  it('deletes jobs older than the retention cutoff', async () => {
    const job = makeJob({ createdAt: new Date('2000-01-01T00:00:00.000Z') });
    await repository.create(job);

    await expect(
      repository.deleteCreatedBefore(new Date('2001-01-01T00:00:00.000Z')),
    ).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      repository.findOwned(owner(job), job.jobId),
    ).resolves.toBeUndefined();
  });
});
