import { Pool } from 'pg';
import { ulid } from 'ulid';

import { AppError } from '@/common/errors/app-error';
import type { SpeakingV2QuestionResult } from '@/contracts/speaking/v2/question-result';
import { releaseSandboxDispatchReservations } from '@/modules/gateway/infrastructure/postgres-sandbox-dispatch-budget';
import type { NewSpeakingGradingJob } from '@/modules/speaking/application/grading-jobs/speaking-grading-job';
import { PostgresSpeakingGradingJobRepository } from '@/modules/speaking/infrastructure/grading-jobs/postgres-speaking-grading-job.repository';
import { testDatabaseUrl } from '../shared/database';
import { createFixturePrismaClient } from '../shared/fixture-prisma-client';

const client = createFixturePrismaClient(
  testDatabaseUrl(),
  undefined,
  'speaking-submit',
);
const repository = new PostgresSpeakingGradingJobRepository(
  client,
  releaseSandboxDispatchReservations,
);
const workerClient = createFixturePrismaClient(
  testDatabaseUrl(),
  undefined,
  'speaking-worker',
);
const workerRepository = new PostgresSpeakingGradingJobRepository(
  workerClient,
  releaseSandboxDispatchReservations,
);
const observerPool = new Pool({
  connectionString: testDatabaseUrl(),
  application_name: 'speaking-admission-observer',
  max: 2,
});
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

async function claimJobForWorker(job: NewSpeakingGradingJob): Promise<void> {
  await expect(
    workerRepository.claim({
      jobId: job.jobId,
      now: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      expireBefore: new Date(NOW.getTime() - 15 * 60_000),
    }),
  ).resolves.toMatchObject({ status: 'running' });
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
  error_priority: [],
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

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

function roomFor(monthlyQuota: number | null): (inFlight: number) => boolean {
  return (inFlight) => monthlyQuota !== null && inFlight < monthlyQuota;
}

async function expectNoAdmissionLockDuringAdmission(
  organizationId: string,
): Promise<void> {
  const result = await observerPool.query<{
    locked: boolean;
    openTransaction: boolean;
  }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM pg_locks
         WHERE locktype = 'advisory'
           AND classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
           AND objid = ((hashtextextended($1, 0) & 4294967295))::oid
           AND objsubid = 1
       ) AS locked,
       EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE application_name = 'speaking-submit'
           AND state = 'idle in transaction'
       ) AS "openTransaction"`,
    [`speaking-grading-quota:${organizationId}`],
  );
  expect(result.rows[0]).toMatchObject({
    locked: false,
    openTransaction: false,
  });
}

describe('Speaking grading job repository in PostgreSQL', () => {
  afterAll(async () =>
    Promise.all([client.close(), workerClient.close(), observerPool.end()]),
  );

  async function createClaimedSucceededJob(
    organizationId: string,
    completedAt: Date = NOW,
  ): Promise<NewSpeakingGradingJob> {
    const job = makeJob({ organizationId });
    await repository.create(job);
    await repository.claim({
      jobId: job.jobId,
      now: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      expireBefore: new Date(NOW.getTime() - 15 * 60_000),
    });
    await repository.succeed({ jobId: job.jobId, result: RESULT, completedAt });
    return job;
  }

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

  it('counts active reservations only for the requested Organization and Environment, across month boundaries', async () => {
    const organizationId = 'org_' + ulid();
    const queued = makeJob({ organizationId, createdAt: NOW });
    const running = makeJob({ organizationId, createdAt: NOW });
    const terminal = makeJob({ organizationId, createdAt: NOW });
    const sandbox = makeJob({
      organizationId,
      environment: 'sandbox',
      createdAt: NOW,
    });
    const otherOrganization = makeJob({ createdAt: NOW });
    // Submitted just before a UTC month boundary, still queued after it.
    const beforeBoundary = makeJob({
      organizationId,
      createdAt: new Date('2026-10-31T23:59:59.000Z'),
    });

    for (const job of [
      queued,
      running,
      terminal,
      sandbox,
      otherOrganization,
      beforeBoundary,
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
      }),
    ).resolves.toBe(3);
  });

  it('keeps a successful job reserved until metering handoff completes', async () => {
    const organizationId = 'org_' + ulid();
    const job = await createClaimedSucceededJob(organizationId);

    const duringMetering = makeJob({ organizationId });
    await expect(
      repository.createWithAdmission({
        job: duringMetering,
        monthlyQuota: 1,
        hasInFlightRoom: roomFor(1),
        admit: async (monthlyQuota) => ({
          admitted: monthlyQuota !== null && monthlyQuota > 0,
        }),
      }),
    ).resolves.toEqual({
      created: false,
      existingJobId: duringMetering.jobId,
    });

    await expect(repository.releaseQuotaReservation(job.jobId)).resolves.toBe(
      true,
    );

    const afterMetering = makeJob({ organizationId });
    await expect(
      repository.createWithAdmission({
        job: afterMetering,
        monthlyQuota: 1,
        hasInFlightRoom: roomFor(1),
        admit: async (monthlyQuota) => ({
          admitted: monthlyQuota !== null && monthlyQuota > 0,
        }),
      }),
    ).resolves.toEqual({ created: true });
  });

  it('stops counting a succeeded job once its meter has charged it, before the release (#1950)', async () => {
    const organizationId = 'org_' + ulid();
    const job = await createClaimedSucceededJob(organizationId);

    const admit = async (monthlyQuota: number | null) => ({
      admitted: monthlyQuota !== null && monthlyQuota > 0,
    });
    const beforeMeter = makeJob({ organizationId });
    await expect(
      repository.createWithAdmission({
        job: beforeMeter,
        monthlyQuota: 1,
        hasInFlightRoom: roomFor(1),
        admit,
      }),
    ).resolves.toEqual({ created: false, existingJobId: beforeMeter.jobId });

    // The meter increments the live counter before it writes this row, and the
    // release can still fail and wait for the sweep, so admission must see the
    // same remaining quota as if the release had already run.
    await client.usageRecord.create({
      data: {
        requestId: job.jobId,
        organizationId,
        apiKeyId: 'key_' + ulid(),
        service: 'speaking',
        operation: 'speaking.v2.question-grading',
        environment: 'production',
        outcome: 'success',
        httpStatus: 200,
        billableRequests: 1,
        meteringStatus: 'complete',
        totalMs: 1,
      },
    });
    // Inside the two-minute grace window, so the sweep has not released it.
    await expect(
      repository.releaseSettledQuotaReservations(
        new Date(NOW.getTime() - 119_999),
      ),
    ).resolves.toBe(0);

    const afterMeter = makeJob({ organizationId });
    await expect(
      repository.createWithAdmission({
        job: afterMeter,
        monthlyQuota: 1,
        hasInFlightRoom: roomFor(1),
        admit,
      }),
    ).resolves.toEqual({ created: true });

    // The release itself changes nothing admission can see: settlement already
    // stopped the double count.
    await expect(repository.releaseQuotaReservation(job.jobId)).resolves.toBe(
      true,
    );
    await expect(
      repository.countInFlight({ organizationId, environment: 'production' }),
    ).resolves.toBe(1);
  });

  it('releases a successful job whose metering handoff never completed once the grace window passes', async () => {
    const organizationId = 'org_' + ulid();
    const settled = makeJob({ organizationId });
    const recent = makeJob({ organizationId });
    for (const [job, completedAt] of [
      [settled, new Date(NOW.getTime() - 300_000)],
      [recent, NOW],
    ] as const) {
      await repository.create(job);
      await repository.claim({
        jobId: job.jobId,
        now: NOW,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        expireBefore: new Date(NOW.getTime() - 15 * 60_000),
      });
      await repository.succeed({
        jobId: job.jobId,
        result: RESULT,
        completedAt,
      });
    }

    await expect(
      repository.releaseSettledQuotaReservations(
        new Date(NOW.getTime() - 120_000),
      ),
    ).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      repository.countInFlight({ organizationId, environment: 'production' }),
    ).resolves.toBe(1);
    await expect(
      repository.releaseQuotaReservation(settled.jobId),
    ).resolves.toBe(false);
    await expect(
      repository.releaseQuotaReservation(recent.jobId),
    ).resolves.toBe(true);
  });

  it('holds no PostgreSQL transaction or advisory lock while graded admission is waiting', async () => {
    const organizationId = 'org_' + ulid();
    const job = makeJob({ organizationId });
    const release = jest.fn(async () => undefined);
    await repository.create(makeJob({ organizationId }));
    const gate = deferred();
    let announceAdmission = (): void => undefined;
    const admissionStarted = new Promise<void>((done) => {
      announceAdmission = done;
    });

    const submission = repository.createWithAdmission({
      job,
      monthlyQuota: 1,
      hasInFlightRoom: roomFor(1),
      admit: async () => {
        announceAdmission();
        await gate.promise;
        return { admitted: true, release };
      },
    });
    await admissionStarted;

    await expectNoAdmissionLockDuringAdmission(organizationId);

    gate.resolve();
    await expect(submission).resolves.toMatchObject({
      created: false,
      inFlightRefused: true,
    });
    expect(release).toHaveBeenCalledTimes(1);
    await expect(
      repository.findOwned(owner(job), job.jobId),
    ).resolves.toBeUndefined();
    await expect(
      repository.countInFlight({ organizationId, environment: 'production' }),
    ).resolves.toBe(1);
  });

  it('serializes concurrent admission against monthly in-flight quota', async () => {
    const organizationId = 'org_' + ulid();
    const jobs = [makeJob({ organizationId }), makeJob({ organizationId })];

    const results = await Promise.all(
      jobs.map((job) =>
        repository.createWithAdmission({
          job,
          monthlyQuota: 1,
          hasInFlightRoom: roomFor(1),
          admit: async (monthlyQuota) => ({
            admitted: monthlyQuota !== null && monthlyQuota > 0,
          }),
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    await expect(
      repository.countInFlight({
        organizationId,
        environment: 'production',
      }),
    ).resolves.toBe(1);
  });

  it('gives the late in-flight refusal back when both admissions read the same remaining quota', async () => {
    const organizationId = 'org_' + ulid();
    const jobs = [makeJob({ organizationId }), makeJob({ organizationId })];
    const releases = jobs.map(() => jest.fn(async () => undefined));
    const gate = deferred();
    let admissionsStarted = 0;
    let announceBoth = (): void => undefined;
    const bothAdmitted = new Promise<void>((done) => {
      announceBoth = done;
    });

    const submissions = jobs.map((job, index) => {
      const release = releases[index];
      return repository.createWithAdmission({
        job,
        monthlyQuota: 1,
        hasInFlightRoom: roomFor(1),
        admit: async () => {
          admissionsStarted += 1;
          if (admissionsStarted === jobs.length) announceBoth();
          await gate.promise;
          return release === undefined
            ? { admitted: true }
            : { admitted: true, release };
        },
      });
    });
    await bothAdmitted;
    gate.resolve();

    const outcomes = await Promise.all(submissions);
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    const loserIndex = outcomes.findIndex(
      (outcome) => !outcome.created && outcome.inFlightRefused === true,
    );
    expect(loserIndex).toBeGreaterThanOrEqual(0);
    expect(releases[loserIndex] ?? jest.fn()).toHaveBeenCalledTimes(1);
    expect(releases[1 - loserIndex] ?? jest.fn()).not.toHaveBeenCalled();
    await expect(
      repository.countInFlight({
        organizationId,
        environment: 'production',
      }),
    ).resolves.toBe(1);
  });

  it('recovers an existing job on duplicate idempotency key admission', async () => {
    const organizationId = 'org_' + ulid();
    const idempotencyKey = 'key_' + ulid();
    const firstJob = makeJob({ organizationId, idempotencyKey });

    const first = await repository.createWithAdmission({
      job: firstJob,
      monthlyQuota: 10,
      hasInFlightRoom: roomFor(10),
      admit: async () => ({ admitted: true }),
    });
    expect(first).toEqual({ created: true });

    const duplicateJob = makeJob({ organizationId, idempotencyKey });
    const second = await repository.createWithAdmission({
      job: duplicateJob,
      monthlyQuota: 10,
      hasInFlightRoom: roomFor(10),
      admit: async () => ({ admitted: true }),
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

  it('gives an admitted reservation back when the job insert aborts', async () => {
    const organizationId = 'org_' + ulid();
    const release = jest.fn(async () => undefined);
    // `part` outside 1..3 fails the table's CHECK constraint on insert.
    const job = makeJob({
      organizationId,
      request: { part: 9, questionId: 'question-1' },
    });

    await expect(
      repository.createWithAdmission({
        job,
        monthlyQuota: 5,
        hasInFlightRoom: roomFor(5),
        admit: async () => ({ admitted: true, release }),
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });

    expect(release).toHaveBeenCalledTimes(1);
    await expect(
      repository.countInFlight({
        organizationId,
        environment: 'production',
      }),
    ).resolves.toBe(0);
    await expect(
      repository.findOwned(owner(job), job.jobId),
    ).resolves.toBeUndefined();
  });

  it('gives a Sandbox reservation back when the job insert aborts', async () => {
    const organizationId = 'org_' + ulid();
    const release = jest.fn(async () => undefined);
    const job = makeJob({
      organizationId,
      environment: 'sandbox',
      request: { part: 9, questionId: 'question-1' },
    });

    await expect(
      repository.createWithAdmission({
        job,
        monthlyQuota: null,
        hasInFlightRoom: roomFor(null),
        admit: async () => ({ admitted: true, release }),
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });

    expect(release).toHaveBeenCalledTimes(1);
    await expect(
      repository.findOwned(owner(job), job.jobId),
    ).resolves.toBeUndefined();
  });

  it('stops waiting on a timed-out Redis admission without a job or reservation', async () => {
    const organizationId = 'org_' + ulid();
    const job = makeJob({ organizationId });
    // real-timer-ok: models the gateway's 400 ms Redis command timeout, which
    // bounds admission now that no transaction spans the call.
    const redisTimeout = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 20));

    await expect(
      repository.createWithAdmission({
        job,
        monthlyQuota: 5,
        hasInFlightRoom: roomFor(5),
        admit: async () => {
          await redisTimeout();
          throw new AppError({
            code: 'REDIS_UNAVAILABLE',
            message: 'graded admission timed out',
            retryable: true,
          });
        },
      }),
    ).rejects.toMatchObject({ code: 'REDIS_UNAVAILABLE' });

    await expect(
      repository.countInFlight({
        organizationId,
        environment: 'production',
      }),
    ).resolves.toBe(0);
    await expect(
      repository.findOwned(owner(job), job.jobId),
    ).resolves.toBeUndefined();
  });

  it.each([
    { name: 'graded', environment: 'production' as const, monthlyQuota: 10 },
    { name: 'Sandbox', environment: 'sandbox' as const, monthlyQuota: null },
  ])(
    'gives the losing admission back when another insert wins before the $name insert',
    async ({ environment, monthlyQuota }) => {
      const organizationId = 'org_' + ulid();
      const idempotencyKey = 'key_' + ulid();
      let releases = 0;
      const jobOverrides = {
        organizationId,
        environment,
        idempotencyKey,
        quotaTracked: monthlyQuota !== null,
      };
      const winnerJob = makeJob(jobOverrides);
      const duplicateJob = makeJob(jobOverrides);
      const outcome = await repository.createWithAdmission({
        job: duplicateJob,
        monthlyQuota,
        hasInFlightRoom: roomFor(monthlyQuota),
        admit: async () => {
          await repository.create(winnerJob);
          return {
            admitted: true,
            release: async () => {
              releases += 1;
            },
          };
        },
      });

      expect(outcome).toEqual({
        created: false,
        existingJobId: winnerJob.jobId,
      });
      expect(releases).toBe(1);
      await expect(
        repository.findByIdempotencyKey({
          organizationId,
          endUserId: winnerJob.endUserId,
          idempotencyKey,
        }),
      ).resolves.toMatchObject({ jobId: winnerJob.jobId });
      await expect(
        repository.countInFlight({ organizationId, environment }),
      ).resolves.toBe(monthlyQuota === null ? 0 : 1);
    },
  );

  it('creates a new job when the idempotency key binding is past 24 hours', async () => {
    const organizationId = 'org_' + ulid();
    const idempotencyKey = 'key_' + ulid();
    const firstCreatedAt = new Date('2026-11-01T00:00:00.000Z');
    const firstJob = makeJob({
      organizationId,
      idempotencyKey,
      createdAt: firstCreatedAt,
    });

    const first = await repository.createWithAdmission({
      job: firstJob,
      monthlyQuota: 10,
      hasInFlightRoom: roomFor(10),
      admit: async () => ({ admitted: true }),
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
      monthlyQuota: 10,
      hasInFlightRoom: roomFor(10),
      admit: async () => ({ admitted: true }),
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

  it('erases only one Organization and End-User across environment values', async () => {
    const organizationId = 'org_' + ulid();
    const endUserId = 'learner-shared';
    const production = makeJob({ organizationId, endUserId });
    const sandbox = makeJob({
      organizationId,
      endUserId,
      environment: 'sandbox',
    });
    const sameUserOtherOrganization = makeJob({
      organizationId: 'org_' + ulid(),
      endUserId,
      environment: 'sandbox',
    });
    const otherUserSameOrganization = makeJob({
      organizationId,
      endUserId: 'learner-other',
    });
    await Promise.all(
      [
        production,
        sandbox,
        sameUserOtherOrganization,
        otherUserSameOrganization,
      ].map((job) => repository.create(job)),
    );

    const subject = { organizationId, endUserId };
    await expect(repository.eraseByEndUser(subject)).resolves.toBe(2);
    await expect(repository.eraseByEndUser(subject)).resolves.toBe(0);
    await expect(
      repository.findOwned(owner(production), production.jobId),
    ).resolves.toBeUndefined();
    await expect(
      repository.findOwned(owner(sandbox), sandbox.jobId),
    ).resolves.toBeUndefined();
    await expect(
      repository.findOwned(
        owner(sameUserOtherOrganization),
        sameUserOtherOrganization.jobId,
      ),
    ).resolves.toMatchObject({ jobId: sameUserOtherOrganization.jobId });
    await expect(
      repository.findOwned(
        owner(otherUserSameOrganization),
        otherUserSameOrganization.jobId,
      ),
    ).resolves.toMatchObject({ jobId: otherUserSameOrganization.jobId });
  });

  it('stops a claimed worker from dispatching or restoring a job erased first', async () => {
    const job = makeJob();
    await repository.create(job);
    await claimJobForWorker(job);

    await expect(
      repository.eraseByEndUser({
        organizationId: job.organizationId,
        endUserId: job.endUserId,
      }),
    ).resolves.toBe(1);
    await expect(
      workerRepository.markDispatchStarted(job.jobId, NOW),
    ).resolves.toBe(false);
    await expect(
      workerRepository.succeed({
        jobId: job.jobId,
        result: RESULT,
        completedAt: NOW,
      }),
    ).resolves.toBe(false);
    await expect(
      workerRepository.findOwned(owner(job), job.jobId),
    ).resolves.toBeUndefined();
  });

  it('releases only the erased Sandbox jobs that never marked dispatch', async () => {
    const organizationId = 'org_' + ulid();
    const queued = makeJob({ organizationId, environment: 'sandbox' });
    const claimed = makeJob({ organizationId, environment: 'sandbox' });
    const dispatched = makeJob({ organizationId, environment: 'sandbox' });
    const otherUser = makeJob({
      organizationId,
      environment: 'sandbox',
      endUserId: 'learner-other',
    });
    const jobs = [queued, claimed, dispatched, otherUser];
    await Promise.all(jobs.map((job) => repository.create(job)));
    await client.sandboxDispatchReservation.createMany({
      data: jobs.map(({ jobId }) => ({
        requestId: jobId,
        organizationId,
        monthStart: new Date('2026-11-01T00:00:00.000Z'),
      })),
    });
    await claimJobForWorker(claimed);
    await claimJobForWorker(dispatched);
    await expect(
      workerRepository.markDispatchStarted(dispatched.jobId, NOW),
    ).resolves.toBe(true);

    await expect(repository.eraseByEndUser(owner(queued))).resolves.toBe(3);
    await expect(repository.eraseByEndUser(owner(queued))).resolves.toBe(0);
    const reservations = await client.sandboxDispatchReservation.findMany({
      where: { organizationId },
    });
    const state = Object.fromEntries(
      reservations.map(({ requestId, status, releasedAt }) => [
        requestId,
        { status, released: releasedAt !== null },
      ]),
    );
    expect(state).toEqual({
      [queued.jobId]: { status: 'released', released: true },
      [claimed.jobId]: { status: 'released', released: true },
      [dispatched.jobId]: { status: 'reserved', released: false },
      [otherUser.jobId]: { status: 'reserved', released: false },
    });
  });

  it('does not recreate an erased job when an already-dispatched worker succeeds', async () => {
    const job = makeJob();
    await repository.create(job);
    await claimJobForWorker(job);
    await expect(
      workerRepository.markDispatchStarted(job.jobId, NOW),
    ).resolves.toBe(true);

    await expect(
      repository.eraseByEndUser({
        organizationId: job.organizationId,
        endUserId: job.endUserId,
      }),
    ).resolves.toBe(1);
    await expect(
      workerRepository.succeed({
        jobId: job.jobId,
        result: RESULT,
        completedAt: NOW,
      }),
    ).resolves.toBe(false);
    await expect(
      workerRepository.findOwned(owner(job), job.jobId),
    ).resolves.toBeUndefined();
  });
});
