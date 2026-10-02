import { Logger } from '@nestjs/common';

import type { UsageRecord } from '@/modules/metering/application/usage-repository.port';
import { NestMeteringFailureLogger } from './nest-metering-failure.logger';

const forbiddenEssay = 'essay content must never appear in logs';

const record = {
  requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  service: 'writing',
  operation: 'writing.task1.grade',
  environment: 'production',
  outcome: 'success',
  httpStatus: 200,
  billableRequests: 1,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  models: [{ provider: 'provider-y', name: 'model-x' }],
  meteringStatus: 'complete',
  totalMs: 100,
  downstreamMs: 80,
  aiProcessingMs: 70,
  essay: forbiddenEssay,
} satisfies UsageRecord & { readonly essay: string };

describe('NestMeteringFailureLogger', () => {
  it('logs the complete safe record without unexpected request content', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    try {
      new NestMeteringFailureLogger().writeFailed(record);

      const message = error.mock.calls[0]?.[0];
      expect(message).toContain(record.requestId);
      expect(message).toContain('inputTokens');
      expect(message).not.toContain(forbiddenEssay);
    } finally {
      error.mockRestore();
    }
  });
});
