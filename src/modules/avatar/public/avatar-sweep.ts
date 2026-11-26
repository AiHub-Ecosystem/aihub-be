export {
  AvatarOrphanSweep,
  type AvatarRecoveryResult,
  type AvatarSweepSummary,
} from '@/modules/avatar/application/avatar-orphan-sweep';
export type { AvatarRepositoryPort } from '@/modules/avatar/application/avatar-repository.port';
export type { AvatarStoragePort } from '@/modules/avatar/application/avatar-storage.port';
export {
  createOperatorAvatarRepository,
  createOperatorAvatarStorage,
} from '@/modules/avatar/avatar-operator.module';
