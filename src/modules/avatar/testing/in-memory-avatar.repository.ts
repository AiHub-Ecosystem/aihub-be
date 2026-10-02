import type {
  AvatarRepositoryPort,
  RecordAvatarResult,
} from '@/modules/avatar/application/avatar-repository.port';
import type { Avatar } from '@/modules/avatar/domain/avatar';

/** Holds the one-Avatar-per-account rule the database enforces. */
export class InMemoryAvatarRepository implements AvatarRepositoryPort {
  readonly avatars = new Map<string, Avatar>();

  async findByUser(userId: string): Promise<Avatar | undefined> {
    return this.avatars.get(userId);
  }

  async record(avatar: Avatar): Promise<RecordAvatarResult> {
    const existing = this.avatars.get(avatar.userId);
    if (existing === undefined) {
      this.avatars.set(avatar.userId, avatar);
      return { kind: 'recorded', avatar };
    }
    return existing.assetId === avatar.assetId
      ? { kind: 'already_recorded', avatar: existing }
      : { kind: 'exists' };
  }
}
