import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/speaking-audio-upload.port';
import { SpeakingAudioUploadSweep } from '@/modules/speaking/application/speaking-audio-upload.sweep';
import { S3SpeakingAudioAssetStorage } from '@/modules/speaking/infrastructure/s3-speaking-audio-asset.storage';
import { createCliSeaweedFsClient } from './seaweedfs-client';

import { runOperatorCommand } from './operator-command-context';

type ClosableUploadRepository = Pick<
  SpeakingAudioUploadRepositoryPort,
  'listCleanupCandidates' | 'removeCleanupCandidate'
> & {
  close(): Promise<void>;
};

export interface SpeakingAudioUploadSweepCliInput {
  readonly databaseUrl: string;
  readonly dryRun: boolean;
  readonly repository?: ClosableUploadRepository;
  readonly storage?: SpeakingAudioAssetStoragePort;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

async function openRepository(
  input: SpeakingAudioUploadSweepCliInput,
): Promise<ClosableUploadRepository> {
  if (input.repository !== undefined) {
    return input.repository;
  }
  const { createOperatorSpeakingAudioClient } = await import(
    './operator-speaking-audio-client'
  );
  return createOperatorSpeakingAudioClient(input.databaseUrl);
}

/** Prints only counts; object keys and End-User IDs never enter operator output. */
export async function runSpeakingAudioUploadSweepCommand(
  input: SpeakingAudioUploadSweepCliInput,
) {
  const repository = await openRepository(input);
  let storage = input.storage;
  if (storage === undefined) {
    const bucket = process.env.SEAWEEDFS_AUDIO_ASSET_BUCKET;
    storage = new S3SpeakingAudioAssetStorage(
      createCliSeaweedFsClient(),
      process.env.AIHUB_RUNTIME_DATABASE_SCOPE === 'sandbox'
        ? bucket === undefined
          ? {}
          : { sandboxBucket: bucket }
        : bucket === undefined
          ? {}
          : { productionBucket: bucket },
    );
  }
  const sweep = new SpeakingAudioUploadSweep(repository, storage);
  const { result } = await runOperatorCommand(
    repository,
    input.now,
    ({ occurredAt }) => sweep.run({ dryRun: input.dryRun, now: occurredAt }),
  );
  (input.emit ?? console.log)(JSON.stringify(result));
  return result;
}
import process from 'node:process';
