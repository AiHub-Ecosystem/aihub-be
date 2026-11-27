import {
  DELETION_CEILING,
  SPEAKING_AUDIO_ORPHAN_GRACE_MS,
  type SpeakingAudioAssetStoragePort,
  SpeakingAudioCoreRepositoryAdapter,
  SpeakingAudioCoreStorageAdapter,
  type SpeakingAudioUploadRepositoryPort,
  SpeakingAudioUploadSweep,
} from '@/modules/speaking/public/speaking-audio-upload-sweep';
import { UploadSessionSweep } from '@/modules/uploads/public';
import { createCliSpeakingAudioAssetStorage } from './speaking-audio-storage';

import { runUploadSessionSweepCli } from './upload-session-sweep-cli';

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
  readonly storage?:
    | (SpeakingAudioAssetStoragePort & { close(): Promise<void> })
    | undefined;
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
): Promise<Awaited<ReturnType<SpeakingAudioUploadSweep['run']>>> {
  const repository = await openRepository(input);
  const storage = input.storage ?? createCliSpeakingAudioAssetStorage();
  const sweep = new SpeakingAudioUploadSweep(
    new UploadSessionSweep(
      new SpeakingAudioCoreRepositoryAdapter(
        repository as unknown as SpeakingAudioUploadRepositoryPort,
      ),
      new SpeakingAudioCoreStorageAdapter(
        storage as SpeakingAudioAssetStoragePort,
      ),
      { orphanGraceMs: SPEAKING_AUDIO_ORPHAN_GRACE_MS },
      DELETION_CEILING,
      2,
    ),
  );
  return runUploadSessionSweepCli({
    repository,
    storage,
    sweep,
    options: input,
  });
}
