import {
  AvatarOrphanSweep,
  type AvatarSweepSummary,
} from '@/modules/avatar/application/avatar-orphan-sweep';
import type { AvatarRepositoryPort } from '@/modules/avatar/application/avatar-repository.port';
import type { AvatarStoragePort } from '@/modules/avatar/application/avatar-storage.port';
import {
  PostgresAvatarRepository,
  createAvatarQueryClient,
} from '@/modules/avatar/infrastructure/postgres-avatar.repository';
import { S3AvatarStorage } from '@/modules/avatar/infrastructure/s3-avatar.storage';
import { createRuntimeSecretProviderFromProcessEnvironment } from '@/modules/secrets/infrastructure/configured-runtime-secret.provider';

import { runOperatorCommand } from './operator-command-context';

export interface AvatarSweepCliInput {
  readonly databaseUrl: string;
  readonly dryRun: boolean;
  readonly repository?: AvatarRepositoryPort & { close(): Promise<void> };
  readonly storage?: AvatarStoragePort;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

function openRepository(
  input: AvatarSweepCliInput,
): AvatarRepositoryPort & { close(): Promise<void> } {
  if (input.repository !== undefined) {
    return input.repository;
  }
  const client = createAvatarQueryClient(input.databaseUrl);
  return Object.assign(new PostgresAvatarRepository(client), {
    close: () => client.close(),
  });
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
  const repository = openRepository(input);
  const storage =
    input.storage ??
    new S3AvatarStorage(createRuntimeSecretProviderFromProcessEnvironment());
  const sweep = new AvatarOrphanSweep(repository, storage);

  const { result } = await runOperatorCommand(
    repository,
    input.now,
    ({ occurredAt }) => sweep.run({ dryRun: input.dryRun, now: occurredAt }),
  );

  emit(JSON.stringify(result));
  return result;
}
