import { createRuntimeSecretProviderFromProcessEnvironment } from '@/modules/secrets/infrastructure/configured-runtime-secret.provider';
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
  const storage =
    input.storage ??
    new S3SpeakingAudioAssetStorage(
      createRuntimeSecretProviderFromProcessEnvironment(),
    );
  const sweep = new SpeakingAudioUploadSweep(repository, storage);
  const { result } = await runOperatorCommand(
    repository,
    input.now,
    ({ occurredAt }) => sweep.run({ dryRun: input.dryRun, now: occurredAt }),
  );
  (input.emit ?? console.log)(JSON.stringify(result));
  return result;
}
