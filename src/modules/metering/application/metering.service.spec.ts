import type { MeteringMode } from '../../../catalog/operation-catalog';
import type { MeteringFinalizeInput } from '../../../common/metering/metering-finalizer.port';
import type { MeteringStatus } from '../../../common/metering/metering.types';
import type { QuotaCounterPort } from '../../gateway/application/quota-counter.port';
import type { MeteringFailureLoggerPort } from './metering-logger.port';
import { MeteringService, resolveMeteringStatus } from './metering.service';
import type { UsageRecord, UsageRepositoryPort } from './usage-repository.port';

class FakeUsageRepository implements UsageRepositoryPort {
  readonly records: UsageRecord[] = [];
  shouldFail = false;

  async insert(record: UsageRecord): Promise<void> {
    if (this.shouldFail) {
      throw new Error('database unavailable');
    }
    this.records.push(record);
  }

  aggregate(): Promise<never> {
    return Promise.reject(new Error('not used in this test'));
  }
}

class FakeFailureLogger implements MeteringFailureLoggerPort {
  readonly records: UsageRecord[] = [];

  writeFailed(record: UsageRecord): void {
    this.records.push(record);
  }
}

class FakeQuotaCounter implements QuotaCounterPort {
  readonly increments: string[] = [];
  shouldFail = false;

  read(): Promise<number> {
    return Promise.resolve(0);
  }

  async increment(input: { readonly organizationId: string }): Promise<void> {
    if (this.shouldFail) {
      throw new Error('quota counter unavailable');
    }
    this.increments.push(input.organizationId);
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

  it('preserves valid partial usage and never fills missing fields with zero', async () => {
    const repository = new FakeUsageRepository();
    const service = new MeteringService(repository);

    await service.finalize({
      ...input,
      usage: { inputTokens: 12 },
    });

    expect(repository.records[0]).toEqual(
      expect.objectContaining({
        meteringStatus: 'missing_usage',
        usage: { inputTokens: 12 },
      }),
    );
    expect(repository.records[0]?.usage).not.toHaveProperty('outputTokens');
    expect(repository.records[0]?.usage).not.toHaveProperty('totalTokens');
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

  it('lets quota-unverified evidence override a supplied metering status', async () => {
    const repository = new FakeUsageRepository();
    const service = new MeteringService(repository);

    await service.finalize({
      ...input,
      meteringStatus: 'complete',
      quotaUnverified: true,
    });

    expect(repository.records[0]?.meteringStatus).toBe('quota_unverified');
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

  const meteringCases: readonly [MeteringMode, MeteringStatus][] = [
    ['none', 'not_applicable'],
    ['model', 'missing_usage'],
  ];

  it.each(meteringCases)(
    'classifies %s operations without fabricating usage',
    (mode, expected) => {
      expect(
        resolveMeteringStatus({
          mode,
          ...(mode === 'model' ? { modelCalled: true } : {}),
        }),
      ).toBe(expected);
    },
  );

  it('keeps explicit no-model operations not applicable without zero tokens', () => {
    expect(
      resolveMeteringStatus({
        mode: 'none',
        modelCalled: false,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }),
    ).toBe('not_applicable');
  });

  it('marks quota as unverified before any usage classification', () => {
    expect(
      resolveMeteringStatus({ mode: 'model', quotaUnverified: true }),
    ).toBe('quota_unverified');
  });
});
