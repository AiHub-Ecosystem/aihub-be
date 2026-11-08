import type {
  AvatarRepositoryPort,
  AvatarUploadGrantRecord,
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
  readonly grants = new Map<
    string,
    (AvatarUploadGrantRecord & {
      readonly createdAt: Date;
      consumed: boolean;
    })[]
  >();
  beforeNextChange: (() => void) | undefined;
  private readonly locks = new Map<string, Promise<void>>();

  async withUserLock<T>(
    userId: string,
    operation: (repository: AvatarRepositoryPort) => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(userId, current);
    await previous;
    try {
      return await operation(this);
    } finally {
      release();
      if (this.locks.get(userId) === current) this.locks.delete(userId);
    }
  }

  async findByUser(userId: string): Promise<Avatar | undefined> {
    return this.avatars.get(userId);
  }

  async recordedObjectKeys(
    objectKeys: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const recorded = new Set(
      [...this.avatars.values()].map((avatar) => avatar.objectKey),
    );
    return new Set(objectKeys.filter((key) => recorded.has(key)));
  }

  /** Test-seam: the grants `now` still leaves usable. */
  openUploads(
    userId: string,
    now: Date = new Date(),
  ): AvatarUploadGrantRecord[] {
    return (this.grants.get(userId) ?? []).filter(
      (grant) => !grant.consumed && grant.expiresAt.getTime() > now.getTime(),
    );
  }

  async openUploadGrants(
    userId: string,
    now: Date,
  ): Promise<readonly AvatarUploadGrantRecord[]> {
    return this.openUploads(userId, now);
  }

  async grantUpload(
    grant: AvatarUploadGrantRecord & {
      readonly userId: string;
      readonly createdAt: Date;
    },
    limits: {
      readonly openLimit: number;
      readonly issuanceLimit: number;
      readonly issuanceWindowMs: number;
    },
  ): Promise<boolean> {
    return this.withUserLock(grant.userId, async () => {
      const held = this.grants.get(grant.userId) ?? [];
      const now = grant.createdAt.getTime();
      const open = held.filter(
        (entry) => !entry.consumed && entry.expiresAt.getTime() > now,
      );
      const since = now - limits.issuanceWindowMs;
      const issuedInWindow = held.filter(
        (entry) => entry.createdAt.getTime() > since,
      );
      if (
        open.length >= limits.openLimit ||
        issuedInWindow.length >= limits.issuanceLimit
      ) {
        return false;
      }
      this.grants.set(grant.userId, [...held, { ...grant, consumed: false }]);
      return true;
    });
  }

  async consumeUploadGrant(userId: string, assetId: string): Promise<void> {
    const held = this.grants.get(userId);
    if (held === undefined) return;
    this.grants.set(
      userId,
      held.map((grant) =>
        grant.assetId === assetId ? { ...grant, consumed: true } : grant,
      ),
    );
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
