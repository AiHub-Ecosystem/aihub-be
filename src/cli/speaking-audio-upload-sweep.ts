import { createSeaweedFsS3Client } from '@/modules/secrets/infrastructure/seaweedfs-s3-client.factory';
import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/speaking-audio-upload.port';
import { SpeakingAudioUploadSweep } from '@/modules/speaking/application/speaking-audio-upload.sweep';
import {
  PostgresSpeakingAudioUploadRepository,
  createSpeakingAudioQueryClient,
} from '@/modules/speaking/infrastructure/postgres-speaking-audio-upload.repository';
import { S3SpeakingAudioAssetStorage } from '@/modules/speaking/infrastructure/s3-speaking-audio-asset.storage';
import { createCliRuntimeSecretProvider } from './runtime-secret-provider';

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

function openRepository(
  input: SpeakingAudioUploadSweepCliInput,
): ClosableUploadRepository {
  if (input.repository !== undefined) {
    return input.repository;
  }
  const client = createSpeakingAudioQueryClient(input.databaseUrl);
  return Object.assign(new PostgresSpeakingAudioUploadRepository(client), {
    close: () => client.close(),
  });
}

/** Prints only counts; object keys and End-User IDs never enter operator output. */
export async function runSpeakingAudioUploadSweepCommand(
  input: SpeakingAudioUploadSweepCliInput,
) {
  const repository = openRepository(input);
  let storage = input.storage;
  if (storage === undefined) {
    const secretProvider = createCliRuntimeSecretProvider();
    const bucket = process.env.SEAWEEDFS_AUDIO_ASSET_BUCKET;
    storage = new S3SpeakingAudioAssetStorage(
      createSeaweedFsS3Client({
        endpoint: process.env.SEAWEEDFS_ENDPOINT_URL,
        region: process.env.SEAWEEDFS_REGION,
        credentials: secretProvider.getSnapshot().seaweedfs,
      }),
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
