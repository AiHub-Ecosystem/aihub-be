import {
  AvatarOrphanSweep,
  type AvatarRepositoryPort,
  type AvatarStoragePort,
  type AvatarSweepSummary,
} from '@/modules/avatar/public/avatar-sweep';
import { createCliAvatarStorage } from './avatar-storage';

import { runOperatorCommand } from './operator-command-context';

export interface AvatarSweepCliInput {
  readonly databaseUrl: string;
  readonly dryRun: boolean;
  readonly repository?: AvatarRepositoryPort & { close(): Promise<void> };
  readonly storage?: AvatarStoragePort;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
  readonly clockSource?: 'process' | 'database';
}

async function openRepository(
  input: AvatarSweepCliInput,
): Promise<AvatarRepositoryPort & { close(): Promise<void> }> {
  if (input.repository !== undefined) {
    return input.repository;
  }
  const { createOperatorAvatarClient } = await import(
    './operator-avatar-client'
  );
  return createOperatorAvatarClient(input.databaseUrl);
}

/**
 * Deletes Avatar objects that no record names once they are old enough
 * (ADR-0068). It prints one JSON line of counts and never an object key, and a
 * database or storage that is not configured fails the run before anything is
 * deleted. Run it once per deployment, like `usage:prune`.
 */
export async function runAvatarSweepCommand(
  input: AvatarSweepCliInput,
): Promise<AvatarSweepSummary> {
  const emit = input.emit ?? console.log;
  const repository = await openRepository(input);
  const storage = input.storage ?? createCliAvatarStorage();
  const sweep = new AvatarOrphanSweep(repository, storage);

  const { result } = await runOperatorCommand(
    repository,
    input.now,
    ({ occurredAt }) => sweep.run({ dryRun: input.dryRun, now: occurredAt }),
  );

  emit(
    JSON.stringify({
      ...result,
      cutoff_source: input.clockSource ?? 'process',
    }),
  );
  return result;
}
