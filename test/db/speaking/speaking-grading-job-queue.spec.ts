import { Queue } from 'bullmq';
import { ulid } from 'ulid';

import { BullmqSpeakingGradingJobConsumer } from '@/modules/speaking/infrastructure/grading-jobs/bullmq-speaking-grading-job.consumer';
import {
  BullmqSpeakingGradingJobQueue,
  SPEAKING_GRADING_JOB_QUEUE_NAMES,
} from '@/modules/speaking/infrastructure/grading-jobs/bullmq-speaking-grading-job.queue';

function testRedisUrl(): string {
  const url = new URL(
    process.env['SPEAKING_GRADING_JOB_TEST_REDIS_URL'] ??
      'redis://127.0.0.1:6379/13',
  );
  if (
    url.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
    url.pathname !== '/13' ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error(
      'Speaking grading job integration Redis must be loopback database 13',
    );
  }
  return url.toString();
}

async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(description);
}

describe('Speaking grading job BullMQ integration', () => {
  let queue: BullmqSpeakingGradingJobQueue | undefined;
  let consumer: BullmqSpeakingGradingJobConsumer | undefined;
  let inspector: Queue<{ jobId: string }> | undefined;

  afterAll(async () => {
    await consumer?.close();
    await queue?.close();
    await inspector?.close();
  });

  it('uses the job id as the queue id, stores only that id, and accepts it again after completion', async () => {
    const redisUrl = testRedisUrl();
    const environment = 'production' as const;
    const jobId = 'sgj_' + ulid();
    const processed: { jobId: string; environment: string }[] = [];
    queue = new BullmqSpeakingGradingJobQueue(redisUrl);
    inspector = new Queue(SPEAKING_GRADING_JOB_QUEUE_NAMES.production, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
    });

    await queue.enqueue({ jobId, environment });
    const pending = await inspector.getJob(jobId);
    expect(pending).toBeDefined();
    expect(pending?.id).toBe(jobId);
    expect(pending?.data).toEqual({ jobId });
    expect(Object.keys(pending?.data ?? {})).toEqual(['jobId']);
    expect(pending?.opts).toMatchObject({
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });

    consumer = new BullmqSpeakingGradingJobConsumer(
      redisUrl,
      async (input) => {
        processed.push(input);
      },
      { concurrency: 2 },
    );

    await waitFor(
      async () => processed.length >= 1,
      'The first BullMQ job was not processed',
    );
    await waitFor(
      async () => (await inspector?.getJob(jobId)) === undefined,
      'The completed BullMQ job was not removed',
    );

    await queue.enqueue({ jobId, environment });
    await waitFor(
      async () => processed.length >= 2,
      'The same BullMQ job id was not accepted after removal',
    );

    expect(processed).toEqual([
      { jobId, environment },
      { jobId, environment },
    ]);
  }, 30_000);
});
