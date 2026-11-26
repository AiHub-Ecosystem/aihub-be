import process from 'node:process';

import { UploadSessionSweep } from '@/modules/uploads/public';
import {
  WRITING_CHART_ORPHAN_GRACE_MS,
  type WritingChartUploadRepositoryPort,
  type WritingChartUploadStoragePort,
  WritingChartUploadSweep,
} from '@/modules/writing/public/chart-uploads';
import { createCliWritingChartStorage } from './writing-chart-storage';

import { runUploadSessionSweepCli } from './upload-session-sweep-cli';

type ClosableRepository = Pick<
  WritingChartUploadRepositoryPort,
  'cleanupCandidates' | 'removeCleanupCandidate'
> & { close(): Promise<void> };

export interface WritingChartUploadSweepCliInput {
  readonly databaseUrl: string;
  readonly dryRun: boolean;
  readonly repository?: ClosableRepository;
  readonly storage?:
    | (WritingChartUploadStoragePort & { close(): Promise<void> })
    | undefined;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
  readonly clockSource?: 'process' | 'database';
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
): Promise<Awaited<ReturnType<WritingChartUploadSweep['run']>>> {
  const repository = await openRepository(input);
  let storage = input.storage;
  if (storage === undefined) {
    const environment =
      process.env['AIHUB_RUNTIME_DATABASE_SCOPE'] === 'sandbox'
        ? 'sandbox'
        : 'production';
    storage = createCliWritingChartStorage(environment);
  }
  const sweep = new WritingChartUploadSweep(
    new UploadSessionSweep(
      repository,
      storage as Pick<
        WritingChartUploadStoragePort,
        'deleteStagingObject' | 'deletePublishedObject'
      >,
      { orphanGraceMs: WRITING_CHART_ORPHAN_GRACE_MS },
    ),
  );
  return runUploadSessionSweepCli({
    repository,
    storage,
    sweep,
    options: input,
  });
}
