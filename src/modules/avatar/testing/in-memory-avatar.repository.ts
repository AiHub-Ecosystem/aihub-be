import type {
  AvatarRepositoryPort,
  RecordAvatarResult,
} from '@/modules/avatar/application/avatar-repository.port';
import type { Avatar } from '@/modules/avatar/domain/avatar';

/**
 * Holds the one-Avatar-per-account rule and the conditional changes the
 * database enforces. `beforeNextChange` runs once, just before the next write,
 * so a test can stand in for a concurrent request that got there first.
 */
export class InMemoryAvatarRepository implements AvatarRepositoryPort {
  readonly avatars = new Map<string, Avatar>();
  beforeNextChange: (() => void) | undefined;

  async findByUser(userId: string): Promise<Avatar | undefined> {
    return this.avatars.get(userId);
  }

  async record(avatar: Avatar): Promise<RecordAvatarResult> {
    this.runConcurrentChange();
    const existing = this.avatars.get(avatar.userId);
    if (existing === undefined) {
      this.avatars.set(avatar.userId, avatar);
      return { kind: 'recorded', avatar };
    }
    return existing.assetId === avatar.assetId
      ? { kind: 'already_recorded', avatar: existing }
      : { kind: 'exists' };
  }

  async replace(previousAssetId: string, avatar: Avatar): Promise<boolean> {
    this.runConcurrentChange();
    if (this.avatars.get(avatar.userId)?.assetId !== previousAssetId) {
      return false;
    }
    this.avatars.set(avatar.userId, avatar);
    return true;
  }

  async remove(userId: string, assetId: string): Promise<boolean> {
    this.runConcurrentChange();
    if (this.avatars.get(userId)?.assetId !== assetId) {
      return false;
    }
    this.avatars.delete(userId);
    return true;
  }

  private runConcurrentChange(): void {
    const change = this.beforeNextChange;
    this.beforeNextChange = undefined;
    change?.();
  }
}
