import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import type { SpeakingV2PartGradeInput } from '@/contracts/speaking/v2/inputs';
import type {
  GradedPipelineContext,
  GradedPipelineEnginePort,
} from '@/modules/gateway/public/graded-pipeline';

import { InFlightCeiling } from './speaking-upload-ceiling';
import type { SpeakingV2ResultOwnershipPort } from './speaking-v2-result-ownership.port';
import { SpeakingV2WorkflowEngine } from './speaking-v2-workflow-engine';

const PART_GRADING = 'speaking.v2.part-grading' as const;
const QUESTION_GRADING = 'speaking.v2.question-grading' as const;

function pipelineContext<K extends OperationId>(
  operation: K,
  prepareInput: GradedPipelineContext<K>['prepareInput'],
): GradedPipelineContext<K> {
  return {
    requestId: 'req_speaking_v2',
    receivedAt: new Date('2026-11-03T00:00:00.000Z'),
    signal: new AbortController().signal,
    dispose: () => undefined,
    operation,
    authenticated: {
      organizationId: 'org_acme',
      apiKeyId: 'ak_acme',
      environment: 'production',
      scopes: ['speaking.grade'],
      rateLimitRpm: 60,
      maxConcurrent: 2,
      monthlyRequestQuota: 10,
      hardStopOnQuota: true,
      allowedEnvironments: ['production'],
    },
    identity: {
      userId: 'user_acme',
      organizationId: 'org_acme',
      scopes: [],
      mode: 'declared_id',
    },
    metering: {
      evidence: {
        operation,
        organizationId: 'org_acme',
        apiKeyId: 'ak_acme',
        environment: 'production',
        settled: false,
      },
      setDimensions: () => undefined,
      addEvidence: () => undefined,
      markCompletionStarted: () => undefined,
      markCompletionSettled: () => undefined,
    },
    markAdmission: () => undefined,
    prepareInput,
  };
}

function gradedPipelineAfterPreparation(
  afterPreparation: () => void,
): GradedPipelineEnginePort {
  return {
    async execute<K extends OperationId>(context: GradedPipelineContext<K>) {
      const prepared = await context.prepareInput(context.signal);
      try {
        afterPreparation();
        throw new Error('fake downstream result');
      } finally {
        prepared.release?.();
      }
    },
  };
}

describe('SpeakingV2WorkflowEngine', () => {
  it('refuses unowned aggregation inputs before downstream dispatch', async () => {
    let downstreamStarted = false;
    const resultOwnership: SpeakingV2ResultOwnershipPort = {
      record: async () => undefined,
      findOwnedIds: async () => [],
    };
    const workflow = new SpeakingV2WorkflowEngine(
      gradedPipelineAfterPreparation(() => {
        downstreamStarted = true;
      }),
      new InFlightCeiling(8),
      resultOwnership,
    );
    const input: SpeakingV2PartGradeInput = {
      part_result_id: 'part-1',
      response_ids: ['response-owned-by-someone-else'],
    };

    await expect(
      workflow.execute(pipelineContext(PART_GRADING, async () => ({ input }))),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(downstreamStarted).toBe(false);
  });

  it('holds the upload slot during parsing and releases it when parsing fails', async () => {
    const uploadCeiling = new InFlightCeiling(1);
    const parseFailure = new Error('multipart parse failed');
    let concurrentUploadRefused = false;
    let downstreamStarted = false;
    const workflow = new SpeakingV2WorkflowEngine(
      gradedPipelineAfterPreparation(() => {
        downstreamStarted = true;
      }),
      uploadCeiling,
      {
        record: async () => undefined,
        findOwnedIds: async () => [],
      },
    );
    const context = pipelineContext(QUESTION_GRADING, async () => {
      try {
        uploadCeiling.enter();
      } catch (error) {
        concurrentUploadRefused =
          error instanceof AppError && error.code === 'CONCURRENCY_LIMIT';
      }
      throw parseFailure;
    });

    await expect(workflow.execute(context)).rejects.toBe(parseFailure);
    expect(concurrentUploadRefused).toBe(true);
    expect(downstreamStarted).toBe(false);
    const releaseAfterFailure = uploadCeiling.enter();
    releaseAfterFailure();
  });
});
