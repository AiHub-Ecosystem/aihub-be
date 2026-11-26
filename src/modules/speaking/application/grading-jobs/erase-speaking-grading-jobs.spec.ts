import { EraseSpeakingGradingJobs } from './erase-speaking-grading-jobs';
import type { SpeakingGradingJobRepositoryPort } from './speaking-grading-job.port';

describe('EraseSpeakingGradingJobs', () => {
  it('returns the number of jobs erased for the requested subject', async () => {
    const repository = {
      eraseByEndUser: jest.fn(async () => 3),
    } satisfies Pick<SpeakingGradingJobRepositoryPort, 'eraseByEndUser'>;
    const useCase = new EraseSpeakingGradingJobs(repository);
    const subject = { organizationId: 'org_acme', endUserId: 'learner-1' };

    await expect(useCase.execute(subject)).resolves.toBe(3);
    expect(repository.eraseByEndUser).toHaveBeenCalledWith(subject);
  });
});
