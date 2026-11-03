import type { OperationId } from '@/catalog/operation-id';
import { internalError } from '@/common/errors/app-error';
import type {
  SpeakingV2PartGradeInput,
  SpeakingV2PartPath,
  SpeakingV2QuestionGradeInput,
  SpeakingV2ResponsePath,
  SpeakingV2TestGradeInput,
  SpeakingV2TestPath,
} from '@/contracts/speaking/v2/inputs';
import type { SpeakingV2PartResult } from '@/contracts/speaking/v2/part-result';
import type { SpeakingV2QuestionResult } from '@/contracts/speaking/v2/question-result';
import type { SpeakingV2TestResult } from '@/contracts/speaking/v2/test-result';
import type {
  GradedPipelineContext,
  GradedPipelineDispatchResult,
  GradedPipelineEnginePort,
} from '@/modules/gateway/public/graded-pipeline';

import { requireOwnedSpeakingResults } from './require-owned-speaking-results';
import type { InFlightCeiling } from './speaking-upload-ceiling';
import type {
  SpeakingV2ResultKind,
  SpeakingV2ResultOwner,
  SpeakingV2ResultOwnershipPort,
} from './speaking-v2-result-ownership.port';

const QUESTION_GRADING = 'speaking.v2.question-grading' as const;
const PART_GRADING = 'speaking.v2.part-grading' as const;
const TEST_GRADING = 'speaking.v2.test-grading' as const;
const RESPONSE_GET = 'speaking.v2.response-get' as const;
const PART_GET = 'speaking.v2.part-get' as const;
const TEST_GET = 'speaking.v2.test-get' as const;

type QuestionContext = GradedPipelineContext<typeof QUESTION_GRADING>;
type PartGradeContext = GradedPipelineContext<typeof PART_GRADING>;
type TestGradeContext = GradedPipelineContext<typeof TEST_GRADING>;
type ResponseGetContext = GradedPipelineContext<typeof RESPONSE_GET>;
type PartGetContext = GradedPipelineContext<typeof PART_GET>;
type TestGetContext = GradedPipelineContext<typeof TEST_GET>;
type SpeakingV2WorkflowContext =
  | QuestionContext
  | PartGradeContext
  | TestGradeContext
  | ResponseGetContext
  | PartGetContext
  | TestGetContext;
type SpeakingV2WorkflowResult =
  | GradedPipelineDispatchResult<SpeakingV2QuestionResult>
  | GradedPipelineDispatchResult<SpeakingV2PartResult>
  | GradedPipelineDispatchResult<SpeakingV2TestResult>;

export class SpeakingV2WorkflowEngine {
  constructor(
    private readonly gradedPipeline: GradedPipelineEnginePort,
    private readonly uploadCeiling: InFlightCeiling,
    private readonly resultOwnership: SpeakingV2ResultOwnershipPort,
  ) {}

  execute(
    context: QuestionContext,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2QuestionResult>>;
  execute(
    context: PartGradeContext,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2PartResult>>;
  execute(
    context: TestGradeContext,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2TestResult>>;
  execute(
    context: ResponseGetContext,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2QuestionResult>>;
  execute(
    context: PartGetContext,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2PartResult>>;
  execute(
    context: TestGetContext,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2TestResult>>;
  execute(
    context: SpeakingV2WorkflowContext,
  ): Promise<SpeakingV2WorkflowResult> {
    switch (context.operation) {
      case QUESTION_GRADING:
        return this.gradeQuestion(context);
      case PART_GRADING:
        return this.gradePart(context);
      case TEST_GRADING:
        return this.gradeTest(context);
      case RESPONSE_GET:
        return this.getResponse(context);
      case PART_GET:
        return this.getPart(context);
      case TEST_GET:
        return this.getTest(context);
    }
  }

  private owner(context: SpeakingV2WorkflowContext): SpeakingV2ResultOwner {
    return {
      organizationId: context.authenticated.organizationId,
      environment: context.authenticated.environment,
      endUserId: context.identity.userId,
    };
  }

  private async requireOwned(
    context: SpeakingV2WorkflowContext,
    kind: SpeakingV2ResultKind,
    ids: readonly string[],
  ): Promise<void> {
    await requireOwnedSpeakingResults(
      this.resultOwnership,
      this.owner(context),
      kind,
      ids,
    );
  }

  private async recordSuccessful(
    context: SpeakingV2WorkflowContext,
    owner: SpeakingV2ResultOwner,
    kind: SpeakingV2ResultKind,
    id: string,
  ): Promise<void> {
    try {
      await this.resultOwnership.record(owner, kind, id);
    } catch (error) {
      const evidence = context.metering.evidence;
      if (evidence !== undefined) evidence.settled = true;
      throw error;
    }
  }

  private gradeQuestion(
    context: QuestionContext,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2QuestionResult>> {
    let partResultId: SpeakingV2QuestionGradeInput['partResultId'];
    return this.executePipeline(
      context,
      async (signal) => {
        const release = this.uploadCeiling.enter();
        try {
          const prepared = await context.prepareInput(signal);
          partResultId = prepared.input.partResultId;
          return {
            input: prepared.input,
            release: () => {
              try {
                prepared.release?.();
              } finally {
                release();
              }
            },
          };
        } catch (error) {
          release();
          throw error;
        }
      },
      async (result) => {
        const owner = this.owner(context);
        await this.recordSuccessful(
          context,
          owner,
          'response',
          result.data.meta.response_id,
        );
        if (partResultId !== undefined) {
          await this.recordSuccessful(context, owner, 'part', partResultId);
        }
      },
    );
  }

  private gradePart(
    context: PartGradeContext,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2PartResult>> {
    let input: SpeakingV2PartGradeInput | undefined;
    return this.executePipeline(
      context,
      async (signal) => {
        const prepared = await context.prepareInput(signal);
        try {
          input = prepared.input;
          if (input.response_ids !== undefined) {
            await this.requireOwned(context, 'response', input.response_ids);
          }
          return prepared;
        } catch (error) {
          prepared.release?.();
          throw error;
        }
      },
      async () => {
        if (input === undefined) {
          throw internalError('Speaking Part input was not prepared');
        }
        const owner = this.owner(context);
        await this.recordSuccessful(
          context,
          owner,
          'part',
          input.part_result_id,
        );
        if (input.test_id !== undefined) {
          await this.recordSuccessful(context, owner, 'test', input.test_id);
        }
      },
    );
  }

  private gradeTest(
    context: TestGradeContext,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2TestResult>> {
    let input: SpeakingV2TestGradeInput | undefined;
    return this.executePipeline(
      context,
      async (signal) => {
        const prepared = await context.prepareInput(signal);
        try {
          input = prepared.input;
          if (input.response_ids !== undefined) {
            await this.requireOwned(context, 'response', input.response_ids);
          }
          if (input.part_result_ids !== undefined) {
            await this.requireOwned(context, 'part', input.part_result_ids);
          }
          return prepared;
        } catch (error) {
          prepared.release?.();
          throw error;
        }
      },
      async () => {
        if (input === undefined) {
          throw internalError('Speaking Test input was not prepared');
        }
        await this.recordSuccessful(
          context,
          this.owner(context),
          'test',
          input.test_id,
        );
      },
    );
  }

  private getResponse(
    context: ResponseGetContext,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2QuestionResult>> {
    return this.executePipeline(context, async (signal) => {
      const prepared = await context.prepareInput(signal);
      try {
        const input: SpeakingV2ResponsePath = prepared.input;
        await this.requireOwned(context, 'response', [input.response_id]);
        return prepared;
      } catch (error) {
        prepared.release?.();
        throw error;
      }
    });
  }

  private getPart(
    context: PartGetContext,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2PartResult>> {
    return this.executePipeline(context, async (signal) => {
      const prepared = await context.prepareInput(signal);
      try {
        const input: SpeakingV2PartPath = prepared.input;
        await this.requireOwned(context, 'part', [input.part_result_id]);
        return prepared;
      } catch (error) {
        prepared.release?.();
        throw error;
      }
    });
  }

  private getTest(
    context: TestGetContext,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2TestResult>> {
    return this.executePipeline(context, async (signal) => {
      const prepared = await context.prepareInput(signal);
      try {
        const input: SpeakingV2TestPath = prepared.input;
        await this.requireOwned(context, 'test', [input.test_id]);
        return prepared;
      } catch (error) {
        prepared.release?.();
        throw error;
      }
    });
  }

  private executePipeline<K extends OperationId>(
    context: GradedPipelineContext<K>,
    prepareInput: GradedPipelineContext<K>['prepareInput'],
    onDispatchResult?: GradedPipelineContext<K>['onDispatchResult'],
  ) {
    return this.gradedPipeline.execute({
      ...context,
      prepareInput,
      ...(onDispatchResult === undefined ? {} : { onDispatchResult }),
    });
  }
}
