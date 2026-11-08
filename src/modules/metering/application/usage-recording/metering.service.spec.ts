import type { MeteringMode } from '@/catalog/operation-catalog';
import type { QuotaCounterPort } from '@/modules/gateway/application/quota-counter.port';
import type {
  MeteringFinalizeInput,
  MeteringStatus,
} from './metering-finalizer.port';
import type { MeteringFailureLoggerPort } from './metering-logger.port';
import type {
  MeteringTelemetryPort,
  MeteringWriteOutcome,
} from './metering-telemetry.port';
import {
  DOWNSTREAM_USAGE_REPORTING,
  METERING_WRITE_TIMEOUT_MS,
  MeteringService,
  resolveMeteringStatus,
} from './metering.service';
import type { UsageRecord, UsageRepositoryPort } from './usage-repository.port';

class FakeUsageRepository implements UsageRepositoryPort {
  readonly records: UsageRecord[] = [];
  shouldFail = false;
  delayMs = 0;

  async insert(record: UsageRecord): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.shouldFail) {
      throw new Error('database unavailable');
    }
    this.records.push(record);
  }
}

class FakeFailureLogger implements MeteringFailureLoggerPort {
  readonly records: UsageRecord[] = [];
  readonly reasons: Array<'timeout' | 'error' | undefined> = [];

  writeFailed(record: UsageRecord, reason?: 'timeout' | 'error'): void {
    this.records.push(record);
    this.reasons.push(reason);
  }
}

class FakeQuotaCounter implements QuotaCounterPort {
  readonly increments: string[] = [];
  readonly occurredAt: Date[] = [];
  shouldFail = false;

  read(): Promise<number> {
    return Promise.resolve(0);
  }

  async increment(input: {
    readonly organizationId: string;
    readonly occurredAt?: Date;
  }): Promise<void> {
    if (this.shouldFail) {
      throw new Error('quota counter unavailable');
    }
    this.increments.push(input.organizationId);
    if (input.occurredAt !== undefined) this.occurredAt.push(input.occurredAt);
  }
}

class FakeTelemetry implements MeteringTelemetryPort {
  readonly durations: Array<{
    outcome: MeteringWriteOutcome;
    seconds: number;
  }> = [];
  readonly failures: Array<Exclude<MeteringWriteOutcome, 'success'>> = [];

  writeDurationSeconds(outcome: MeteringWriteOutcome, seconds: number): void {
    this.durations.push({ outcome, seconds });
  }

  writeFailed(reason: Exclude<MeteringWriteOutcome, 'success'>): void {
    this.failures.push(reason);
  }
}

const input: MeteringFinalizeInput = {
  requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  actorId: 'student_123',
  operation: 'writing.task1.grade',
  environment: 'production',
  outcome: 'success',
  httpStatus: 200,
  usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
  models: [{ provider: 'provider-y', name: 'model-x' }],
  totalMs: 100,
  downstreamMs: 80,
  aiProcessingMs: 70,
};

describe('MeteringService', () => {
  it('does not meter a retrieval operation', () => {
    expect(
      resolveMeteringStatus({
        mode: 'none',
        usageReportingExpected: true,
        modelCalled: true,
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      }),
    ).toBe('not_applicable');
  });

  it('does not bill or count quota for an injected non-metered operation', async () => {
    const repository = new FakeUsageRepository();
    const quota = new FakeQuotaCounter();
    const service = new MeteringService(
      repository,
      new FakeFailureLogger(),
      quota,
      {
        'speaking.grading': { meteringMode: 'none', downstream: 'ai-speaking' },
      },
    );

    await service.finalize({ ...input, operation: 'speaking.grading' });

    expect(repository.records[0]?.billableRequests).toBe(0);
    expect(quota.increments).toEqual([]);
  });

  it('declares the current usage policy for every catalogued downstream', () => {
    expect(DOWNSTREAM_USAGE_REPORTING).toEqual({
      'ai-writing': false,
      'ai-speaking': true,
    });
  });

  it('writes a complete billable record without changing provider totals', async () => {
    const repository = new FakeUsageRepository();
    const service = new MeteringService(repository);

    await service.finalize(input);

    expect(repository.records).toEqual([
      expect.objectContaining({
        requestId: input.requestId,
        service: 'writing',
        operation: input.operation,
        billableRequests: 1,
        meteringStatus: 'complete',
        usage: input.usage,
        models: input.models,
      }),
    ]);
  });

  it('bills a background completion once and counts it against quota once', async () => {
    const repository = new FakeUsageRepository();
    const quota = new FakeQuotaCounter();
    const service = new MeteringService(
      repository,
      new FakeFailureLogger(),
      quota,
    );

    await service.finalize({
      ...input,
      requestId: 'req_late:background',
      billingBasis: 'background_completion',
      quotaTracked: true,
    });

    expect({
      records: repository.records.map(({ billingBasis, billableRequests }) => ({
        billingBasis,
        billableRequests,
      })),
      increments: quota.increments,
    }).toEqual({
      records: [{ billingBasis: 'background_completion', billableRequests: 1 }],
      increments: ['org_acme'],
    });
  });

  it('records an ordinary request as billing its response', async () => {
    const repository = new FakeUsageRepository();

    await new MeteringService(repository).finalize(input);

    expect(repository.records[0]?.billingBasis).toBe('response');
  });

  it('keeps incomplete usage unremarkable for non-reporting AI Writing', async () => {
    const repository = new FakeUsageRepository();
    const service = new MeteringService(repository);

    for (const operation of [
      'writing.task1.grade',
      'writing.task2.grade',
    ] as const) {
      await service.finalize({
        ...input,
        operation,
        usage: { inputTokens: 12 },
      });
    }

    expect(repository.records.map((record) => record.meteringStatus)).toEqual([
      'not_applicable',
      'not_applicable',
    ]);
  });

  it('flags incomplete usage for reporting AI Speaking operations', async () => {
    const repository = new FakeUsageRepository();
    const service = new MeteringService(repository);

    for (const operation of [
      'speaking.grading',
      'speaking.grading-json',
    ] as const) {
      await service.finalize({
        ...input,
        operation,
        usage: { inputTokens: 12 },
      });
    }

    expect(repository.records.map((record) => record.meteringStatus)).toEqual([
      'missing_usage',
      'missing_usage',
    ]);
    expect(repository.records.map((record) => record.usage)).toEqual([
      { inputTokens: 12 },
      { inputTokens: 12 },
    ]);
  });

  // A token count above the largest exactly representable integer is not a
  // count. `Number.isInteger` calls it one, and a usage record that reads as
  // complete while its own numbers cannot be summed exactly is worse than one
  // that admits something is missing.
  it('refuses a token count that cannot be represented exactly', async () => {
    const repository = new FakeUsageRepository();
    const service = new MeteringService(repository);

    await service.finalize({
      ...input,
      operation: 'speaking.grading',
      usage: {
        inputTokens: Number.MAX_SAFE_INTEGER + 1,
        outputTokens: 8,
        totalTokens: 20,
      },
    });

    expect(repository.records[0]).toEqual(
      expect.objectContaining({ meteringStatus: 'missing_usage' }),
    );
  });

  it('preserves valid partial usage without marking a non-reporting service anomalous', async () => {
    const repository = new FakeUsageRepository();
    const service = new MeteringService(repository);

    await service.finalize({
      ...input,
      usage: { inputTokens: 12 },
    });
    await service.finalize({
      ...input,
      usage: { inputTokens: -1, outputTokens: 8, totalTokens: 20 },
    });

    expect(repository.records[0]).toEqual(
      expect.objectContaining({
        meteringStatus: 'not_applicable',
        usage: { inputTokens: 12 },
      }),
    );
    expect(repository.records[0]?.usage).not.toHaveProperty('outputTokens');
    expect(repository.records[0]?.usage).not.toHaveProperty('totalTokens');
    expect(repository.records[1]).toEqual(
      expect.objectContaining({
        meteringStatus: 'not_applicable',
        usage: { outputTokens: 8, totalTokens: 20 },
      }),
    );
    expect(repository.records[1]?.usage).not.toHaveProperty('inputTokens');
  });

  it('does not bill an idempotency replay even though it completed successfully', async () => {
    const repository = new FakeUsageRepository();
    const service = new MeteringService(repository);

    await service.finalize({ ...input, idempotentReplay: true });

    expect(repository.records[0]?.billableRequests).toBe(0);
    expect(repository.records[0]?.outcome).toBe('success');
  });

  it('increments the quota counter for a tracked billable record', async () => {
    const repository = new FakeUsageRepository();
    const counter = new FakeQuotaCounter();
    const service = new MeteringService(repository, undefined, counter);

    await service.finalize({ ...input, quotaTracked: true });

    expect(counter.increments).toEqual(['org_acme']);
    expect(repository.records).toHaveLength(1);
  });

  it('uses asynchronous event time for usage record and quota month', async () => {
    const repository = new FakeUsageRepository();
    const counter = new FakeQuotaCounter();
    const service = new MeteringService(repository, undefined, counter);
    const occurredAt = new Date('2026-10-31T23:59:59.000Z');

    await service.finalize({ ...input, quotaTracked: true, occurredAt });

    expect(repository.records[0]?.occurredAt).toBe(occurredAt);
    expect(counter.occurredAt).toEqual([occurredAt]);
  });

  it('does not increment the quota counter for a replay', async () => {
    const repository = new FakeUsageRepository();
    const counter = new FakeQuotaCounter();
    const service = new MeteringService(repository, undefined, counter);

    await service.finalize({
      ...input,
      quotaTracked: true,
      idempotentReplay: true,
    });

    expect(counter.increments).toHaveLength(0);
    expect(repository.records[0]?.billableRequests).toBe(0);
  });

  it('keeps the successful response path when the quota increment fails', async () => {
    const repository = new FakeUsageRepository();
    const counter = new FakeQuotaCounter();
    counter.shouldFail = true;
    const service = new MeteringService(repository, undefined, counter);

    await expect(
      service.finalize({ ...input, quotaTracked: true }),
    ).resolves.toBeUndefined();

    expect(repository.records[0]).toEqual(
      expect.objectContaining({
        billableRequests: 1,
        meteringStatus: 'quota_unverified',
      }),
    );
  });

  it('preserves quota-unverified evidence for an allowed non-billable outcome', async () => {
    const repository = new FakeUsageRepository();
    const counter = new FakeQuotaCounter();
    const service = new MeteringService(repository, undefined, counter);

    await service.finalize({
      ...input,
      outcome: 'client_error',
      httpStatus: 400,
      modelCalled: false,
      quotaTracked: true,
      quotaUnverified: true,
    });

    expect(counter.increments).toHaveLength(0);
    expect(repository.records[0]).toEqual(
      expect.objectContaining({
        billableRequests: 0,
        meteringStatus: 'quota_unverified',
      }),
    );
  });

  it('reports the status only after the quota mutation that can change it', async () => {
    const repository = new FakeUsageRepository();
    const counter = new FakeQuotaCounter();
    counter.shouldFail = true;
    const service = new MeteringService(repository, undefined, counter);
    const statuses: string[] = [];

    await service.finalize({
      ...input,
      outcome: 'success',
      httpStatus: 200,
      quotaTracked: true,
      onStatusWritten: (status) => statuses.push(status),
    });

    // Reported once, and as the status actually persisted. A reader that
    // learned the status before the quota counter rejected would report
    // `missing_usage` for a record stored as `quota_unverified`.
    expect(statuses).toEqual(['quota_unverified']);
    expect(repository.records[0]?.meteringStatus).toBe('quota_unverified');
  });

  it('reports the resolved status when the quota counter accepts', async () => {
    const repository = new FakeUsageRepository();
    const counter = new FakeQuotaCounter();
    const service = new MeteringService(repository, undefined, counter);
    const statuses: string[] = [];

    await service.finalize({
      ...input,
      outcome: 'success',
      httpStatus: 200,
      quotaTracked: true,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      onStatusWritten: (status) => statuses.push(status),
    });

    expect(statuses).toEqual(['complete']);
  });

  it('marks an authenticated failure before dispatch as not applicable', async () => {
    const repository = new FakeUsageRepository();
    const service = new MeteringService(repository);

    await service.finalize({
      ...input,
      outcome: 'client_error',
      httpStatus: 400,
      modelCalled: false,
    });

    expect(repository.records[0]?.meteringStatus).toBe('not_applicable');
  });

  it('keeps a metering write failure off the customer path and logs the full safe record', async () => {
    const repository = new FakeUsageRepository();
    repository.shouldFail = true;
    const logger = new FakeFailureLogger();
    const service = new MeteringService(repository, logger);

    await expect(service.finalize(input)).resolves.toBeUndefined();
    expect(logger.records).toHaveLength(1);
    expect(logger.records[0]).toEqual(
      expect.objectContaining({ requestId: input.requestId }),
    );
  });

  const meteringCases: readonly [MeteringMode, boolean, MeteringStatus][] = [
    ['none', false, 'not_applicable'],
    ['model', true, 'missing_usage'],
  ];

  it.each(meteringCases)(
    'classifies %s operations without fabricating usage',
    (mode, usageReportingExpected, expected) => {
      expect(
        resolveMeteringStatus({
          mode,
          usageReportingExpected,
          ...(mode === 'model' ? { modelCalled: true } : {}),
        }),
      ).toBe(expected);
    },
  );

  it('keeps explicit no-model operations not applicable without zero tokens', () => {
    expect(
      resolveMeteringStatus({
        mode: 'model',
        modelCalled: false,
        usageReportingExpected: false,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }),
    ).toBe('not_applicable');
  });

  it('marks quota as unverified before any usage classification', () => {
    expect(
      resolveMeteringStatus({
        mode: 'model',
        usageReportingExpected: true,
        quotaUnverified: true,
      }),
    ).toBe('quota_unverified');
  });

  it('does not flag missing usage for a service not expected to report it', () => {
    expect(
      resolveMeteringStatus({
        mode: 'model',
        modelCalled: true,
        usageReportingExpected: false,
      }),
    ).toBe('not_applicable');
  });

  it('keeps complete usage complete when reporting is enabled', () => {
    expect(
      resolveMeteringStatus({
        mode: 'model',
        modelCalled: true,
        usageReportingExpected: true,
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      }),
    ).toBe('complete');
  });

  it('flags incomplete usage when a service is expected to report it', () => {
    expect(
      resolveMeteringStatus({
        mode: 'model',
        modelCalled: true,
        usageReportingExpected: true,
        usage: { inputTokens: 12 },
      }),
    ).toBe('missing_usage');
  });

  it('flags invalid usage when reporting is enabled', () => {
    expect(
      resolveMeteringStatus({
        mode: 'model',
        modelCalled: true,
        usageReportingExpected: true,
        usage: { inputTokens: -1, outputTokens: 8, totalTokens: 20 },
      }),
    ).toBe('missing_usage');
  });

  it('does not let AI processing time decide token completeness', async () => {
    const repository = new FakeUsageRepository();
    const service = new MeteringService(repository);

    await service.finalize({
      ...input,
      usage: { inputTokens: 12 },
      aiProcessingMs: 70,
    });
    await service.finalize({
      ...input,
      usage: { inputTokens: 12 },
      aiProcessingMs: -1,
    });

    expect(repository.records).toEqual([
      expect.objectContaining({
        meteringStatus: 'not_applicable',
        aiProcessingMs: 70,
      }),
      expect.objectContaining({ meteringStatus: 'not_applicable' }),
    ]);
    expect(repository.records[1]).not.toHaveProperty('aiProcessingMs');
  });

  it('stops waiting at the timeout bound, counts the write lost, and keeps the record landed', async () => {
    const repository = new FakeUsageRepository();
    repository.delayMs = METERING_WRITE_TIMEOUT_MS * 3;
    const logger = new FakeFailureLogger();
    const telemetry = new FakeTelemetry();
    const service = new MeteringService(
      repository,
      logger,
      undefined,
      undefined,
      telemetry,
    );
    const startedAt = performance.now();

    await service.finalize(input);

    const elapsedMs = performance.now() - startedAt;
    // The request path is bounded; it does not wait the full 3x delay.
    expect(elapsedMs).toBeLessThan(METERING_WRITE_TIMEOUT_MS * 2);
    // The race was lost, so the record has not landed within the bound.
    expect(repository.records).toHaveLength(0);
    expect(telemetry.failures).toEqual(['timeout']);
    expect(logger.records).toHaveLength(1);
    expect(logger.reasons).toEqual(['timeout']);
  });

  it('reports a slow-but-landed insert as timeout, never as success', async () => {
    const repository = new FakeUsageRepository();
    repository.delayMs = METERING_WRITE_TIMEOUT_MS + 50;
    const logger = new FakeFailureLogger();
    const telemetry = new FakeTelemetry();
    const service = new MeteringService(
      repository,
      logger,
      undefined,
      undefined,
      telemetry,
    );

    await service.finalize(input);

    expect(telemetry.durations).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: 'timeout' })]),
    );
    expect(telemetry.failures).toEqual(['timeout']);
    // The insert still lands late; the bound only stops the caller waiting.
    await new Promise((resolve) =>
      setTimeout(resolve, METERING_WRITE_TIMEOUT_MS + 100),
    );
    expect(repository.records).toHaveLength(1);
  });

  it('counts a rejected insert as error, not timeout', async () => {
    const repository = new FakeUsageRepository();
    repository.shouldFail = true;
    const telemetry = new FakeTelemetry();
    const logger = new FakeFailureLogger();
    const service = new MeteringService(
      repository,
      logger,
      undefined,
      undefined,
      telemetry,
    );

    await service.finalize(input);

    expect(telemetry.durations).toEqual([
      expect.objectContaining({ outcome: 'error' }),
    ]);
    expect(telemetry.failures).toEqual(['error']);
    expect(logger.reasons).toEqual(['error']);
  });

  it('never lets a metering write failure change the caller result', async () => {
    const slow = new FakeUsageRepository();
    slow.delayMs = METERING_WRITE_TIMEOUT_MS * 3;
    const slowService = new MeteringService(slow);
    await expect(slowService.finalize(input)).resolves.toBeUndefined();

    const failing = new FakeUsageRepository();
    failing.shouldFail = true;
    const failingService = new MeteringService(failing);
    await expect(failingService.finalize(input)).resolves.toBeUndefined();
  });
});
