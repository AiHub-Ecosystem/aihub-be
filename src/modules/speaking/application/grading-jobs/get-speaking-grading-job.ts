import { AppError } from '@/common/errors/app-error';
import type { SpeakingGradingJobPollData } from '@/contracts/speaking/v2/grading-job';
import {
  type SpeakingGradingJobOwner,
  isSpeakingGradingJobId,
} from './speaking-grading-job';
import type { SpeakingGradingJobRepositoryPort } from './speaking-grading-job.port';

function notFound(): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    message: 'Speaking grading job not found',
    retryable: false,
  });
}

export class GetSpeakingGradingJob {
  constructor(private readonly repository: SpeakingGradingJobRepositoryPort) {}

  async execute(input: {
    readonly owner: SpeakingGradingJobOwner;
    readonly jobId: string;
  }): Promise<SpeakingGradingJobPollData> {
    if (!isSpeakingGradingJobId(input.jobId)) throw notFound();
    const job = await this.repository.findOwned(input.owner, input.jobId);
    if (job === undefined) throw notFound();

    return {
      job_id: job.jobId,
      status: job.status,
      created_at: job.createdAt.toISOString(),
      ...(job.completedAt === undefined
        ? {}
        : { completed_at: job.completedAt.toISOString() }),
      ...(job.result === undefined ? {} : { result: job.result }),
      ...(job.error === undefined ? {} : { error: job.error }),
    };
  }
}
