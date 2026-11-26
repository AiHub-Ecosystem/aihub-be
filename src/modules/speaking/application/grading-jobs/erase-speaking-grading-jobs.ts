import type { SpeakingGradingJobRepositoryPort } from './speaking-grading-job.port';

export class EraseSpeakingGradingJobs {
  constructor(
    private readonly repository: Pick<
      SpeakingGradingJobRepositoryPort,
      'eraseByEndUser'
    >,
  ) {}

  execute(input: {
    readonly organizationId: string;
    readonly endUserId: string;
  }): Promise<number> {
    return this.repository.eraseByEndUser(input);
  }
}
