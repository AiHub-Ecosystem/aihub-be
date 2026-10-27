import process from 'node:process';

import type {
  WritingChartUploadRepositoryPort,
  WritingChartUploadStoragePort,
} from '@/modules/writing/application/writing-chart-upload.port';
import { WritingChartUploadSweep } from '@/modules/writing/application/writing-chart-upload.sweep';
import { S3WritingChartUploadStorage } from '@/modules/writing/infrastructure/s3-writing-chart-upload.storage';
import { createCliSeaweedFsClient } from './seaweedfs-client';

import { runOperatorCommand } from './operator-command-context';

type ClosableRepository = Pick<
  WritingChartUploadRepositoryPort,
  'cleanupCandidates' | 'removeCleanupCandidate'
> & { close(): Promise<void> };

export interface WritingChartUploadSweepCliInput {
  readonly databaseUrl: string;
  readonly dryRun: boolean;
  readonly repository?: ClosableRepository;
  readonly storage?: WritingChartUploadStoragePort;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

async function openRepository(
  input: WritingChartUploadSweepCliInput,
): Promise<ClosableRepository> {
  if (input.repository !== undefined) return input.repository;
  const { createOperatorWritingChartClient } = await import(
    './operator-writing-chart-client'
  );
  return createOperatorWritingChartClient(input.databaseUrl);
}

export async function runWritingChartUploadSweepCommand(
  input: WritingChartUploadSweepCliInput,
) {
  const repository = await openRepository(input);
  let storage = input.storage;
  if (storage === undefined) {
    const environment =
      process.env.AIHUB_RUNTIME_DATABASE_SCOPE === 'sandbox'
        ? 'sandbox'
        : 'production';
    storage = new S3WritingChartUploadStorage(createCliSeaweedFsClient(), {
      environment,
      ...(process.env.SEAWEEDFS_CHART_STAGING_BUCKET === undefined
        ? {}
        : { stagingBucket: process.env.SEAWEEDFS_CHART_STAGING_BUCKET }),
      ...(process.env.SEAWEEDFS_CHART_PUBLIC_BUCKET === undefined
        ? {}
        : { publicBucket: process.env.SEAWEEDFS_CHART_PUBLIC_BUCKET }),
      ...(process.env.AIHUB_CHART_PUBLIC_BASE_URL === undefined
        ? {}
        : { publicBaseUrl: process.env.AIHUB_CHART_PUBLIC_BASE_URL }),
    });
  }
  const sweep = new WritingChartUploadSweep(
    repository,
    storage as Pick<
      WritingChartUploadStoragePort,
      'deleteStagingObject' | 'deletePublishedObject'
    >,
  );
  const { result } = await runOperatorCommand(
    repository,
    input.now,
    ({ occurredAt }) => sweep.run({ dryRun: input.dryRun, now: occurredAt }),
  );
  (input.emit ?? console.log)(JSON.stringify(result));
  return result;
}
