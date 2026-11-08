import type { OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';

import type { SpeakingGradingJobQueuePort } from '@/modules/speaking/application/grading-jobs/speaking-grading-job.port';
import type { SpeakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';

export const SPEAKING_GRADING_JOB_QUEUE_NAMES = {
  production: 'aihub-speaking-grading-production',
  sandbox: 'aihub-speaking-grading-sandbox',
} as const;

export class BullmqSpeakingGradingJobQueue
  implements SpeakingGradingJobQueuePort, OnApplicationShutdown
{
  private readonly queues: Record<
    SpeakingAudioEnvironment,
    Queue<{ jobId: string }>
  >;

  constructor(redisUrl: string) {
    const connection = { url: redisUrl, maxRetriesPerRequest: null };
    this.queues = {
      production: new Queue(SPEAKING_GRADING_JOB_QUEUE_NAMES.production, {
        connection,
      }),
      sandbox: new Queue(SPEAKING_GRADING_JOB_QUEUE_NAMES.sandbox, {
        connection,
      }),
    };
  }

  async enqueue(input: {
    readonly jobId: string;
    readonly environment: SpeakingAudioEnvironment;
    readonly delayMs?: number;
  }): Promise<void> {
    await this.queues[input.environment].add(
      'grade',
      { jobId: input.jobId },
      {
        jobId: input.jobId,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
        ...(input.delayMs === undefined ? {} : { delay: input.delayMs }),
      },
    );
  }

  async close(): Promise<void> {
    await Promise.all(Object.values(this.queues).map((queue) => queue.close()));
  }

  onApplicationShutdown(): Promise<void> {
    return this.close();
  }
}
