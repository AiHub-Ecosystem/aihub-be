import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Worker } from 'bullmq';

import type { SpeakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';

import { SPEAKING_GRADING_JOB_QUEUE_NAMES } from './bullmq-speaking-grading-job.queue';

export interface SpeakingGradingJobHandlerInput {
  readonly jobId: string;
  readonly environment: SpeakingAudioEnvironment;
}

export type SpeakingGradingJobHandler = (
  input: SpeakingGradingJobHandlerInput,
) => Promise<void>;

export class BullmqSpeakingGradingJobConsumer implements OnApplicationShutdown {
  private readonly logger = new Logger(BullmqSpeakingGradingJobConsumer.name);
  private readonly workers: readonly Worker<{ jobId: string }>[];

  constructor(
    redisUrl: string,
    handler: SpeakingGradingJobHandler,
    options: { readonly concurrency: number },
  ) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError('Speaking grading job concurrency must be positive');
    }

    const connection = { url: redisUrl, maxRetriesPerRequest: null };
    this.workers = (['production', 'sandbox'] as const).map((environment) => {
      const worker = new Worker<{ jobId: string }>(
        SPEAKING_GRADING_JOB_QUEUE_NAMES[environment],
        async (job) => {
          const jobId =
            typeof job?.data?.jobId === 'string' ? job.data.jobId : undefined;
          try {
            if (jobId === undefined || jobId.length === 0) {
              this.logger.error(
                JSON.stringify({ code: 'invalid_job_payload' }),
              );
              return;
            }
            await handler({ jobId, environment });
          } catch {
            this.logger.error(
              JSON.stringify({ code: 'job_handler_failed', jobId }),
            );
          }
        },
        {
          connection,
          concurrency: options.concurrency,
          maxStalledCount: 0,
        },
      );
      worker.on('error', () => {
        this.logger.error(JSON.stringify({ code: 'worker_error' }));
      });
      return worker;
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }

  onApplicationShutdown(): Promise<void> {
    return this.close();
  }
}
