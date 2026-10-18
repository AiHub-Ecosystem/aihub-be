import type { AvatarRepositoryPort } from '@/modules/avatar/application/avatar-repository.port';
import { avatarObjectKey } from '@/modules/avatar/domain/avatar';
import type { Avatar } from '@/modules/avatar/domain/avatar';
import { ulid } from 'ulid';

export function avatarRepositoryContract(
  createRepo: () => AvatarRepositoryPort,
  reset: () => Promise<void>,
  userId: string = 'usr_1',
): void {
  const A1 = 'ava_' + ulid();
  const A2 = 'ava_' + ulid();
  let repo: AvatarRepositoryPort;

  beforeEach(async () => {
    await reset();
    repo = createRepo();
  });

  const avatar = (assetId: string): Avatar => ({
    assetId,
    userId,
    objectKey: avatarObjectKey(userId, assetId),
    contentType: 'image/png',
    byteSize: 10,
    acceptedAt: new Date('2026-09-23T00:00:00.000Z'),
  });

  it('records first avatar', async () => {
    const r = await repo.record(avatar(A1));
    expect(r).toEqual({ kind: 'recorded', avatar: avatar(A1) });
  });

  it('already_recorded on same asset', async () => {
    await repo.record(avatar(A1));
    const r = await repo.record(avatar(A1));
    expect(r.kind).toBe('already_recorded');
  });

  it('exists on different asset', async () => {
    await repo.record(avatar(A1));
    const r = await repo.record(avatar(A2));
    expect(r).toEqual({ kind: 'exists' });
  });

  it('replace succeeds with matching previous asset', async () => {
    await repo.record(avatar(A1));
    const ok = await repo.replace(A1, avatar(A2));
    expect(ok).toBe(true);
    expect((await repo.findByUser(userId))?.assetId).toBe(A2);
  });

  it('replace fails on mismatched previous asset', async () => {
    await repo.record(avatar(A1));
    const ok = await repo.replace('nope', avatar(A2));
    expect(ok).toBe(false);
  });

  it('remove succeeds with matching asset', async () => {
    await repo.record(avatar(A1));
    const ok = await repo.remove(userId, A1);
    expect(ok).toBe(true);
    expect(await repo.findByUser(userId)).toBeUndefined();
  });

  it('remove fails on mismatched asset', async () => {
    await repo.record(avatar(A1));
    const ok = await repo.remove(userId, 'nope');
    expect(ok).toBe(false);
  });
}
