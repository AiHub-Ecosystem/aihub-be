import {
  type SpeakingAudioAssetStoragePort,
  type SpeakingAudioUploadRepositoryPort,
  SpeakingAudioUploadSweep,
} from '@/modules/speaking/public/speaking-audio-upload-sweep';
import { createCliSpeakingAudioAssetStorage } from './speaking-audio-storage';

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
  readonly clockSource?: 'process' | 'database';
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
  const storage = input.storage ?? createCliSpeakingAudioAssetStorage();
  const sweep = new SpeakingAudioUploadSweep(repository, storage);
  const { result } = await runOperatorCommand(
    repository,
    input.now,
    ({ occurredAt }) => sweep.run({ dryRun: input.dryRun, now: occurredAt }),
  );
  (input.emit ?? console.log)(
    JSON.stringify({
      ...result,
      cutoff_source: input.clockSource ?? 'process',
    }),
  );
  return result;
}
