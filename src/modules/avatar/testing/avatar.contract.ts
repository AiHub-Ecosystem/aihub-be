import type { AvatarRepositoryPort } from '@/modules/avatar/application/avatar-repository.port';
import { type Avatar, avatarObjectKey } from '@/modules/avatar/domain/avatar';
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

/** Upload-grant ceilings (#374), run against every repository implementation. */
export function avatarUploadGrantContract(
  createRepo: () => AvatarRepositoryPort,
  reset: () => Promise<void>,
  userId: string = 'usr_1',
): void {
  const NOW = new Date('2026-10-02T10:00:00.000Z');
  const LIMITS = {
    openLimit: 2,
    issuanceLimit: 3,
    issuanceWindowMs: 60 * 60 * 1000,
  } as const;
  let repo: AvatarRepositoryPort;
  let minted = 0;

  beforeEach(async () => {
    await reset();
    repo = createRepo();
    minted = 0;
  });

  const grant = (overrides: { readonly createdAt?: Date } = {}) => {
    minted += 1;
    const assetId = `ava_01J00000000000000000000${String(minted).padStart(2, '0')}`;
    const createdAt = overrides.createdAt ?? NOW;
    return {
      assetId,
      userId,
      objectKey: avatarObjectKey(userId, assetId),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 5 * 60 * 1000),
    };
  };

  it('records a grant and counts it as open', async () => {
    const g = grant();
    await expect(repo.grantUpload(g, LIMITS)).resolves.toBe(true);
    expect(await repo.openUploadGrants(userId, NOW)).toEqual([
      expect.objectContaining({
        assetId: g.assetId,
        objectKey: g.objectKey,
        expiresAt: g.expiresAt,
      }),
    ]);
  });

  it('refuses past the open-URL limit', async () => {
    await repo.grantUpload(grant(), LIMITS);
    await repo.grantUpload(grant(), LIMITS);
    await expect(repo.grantUpload(grant(), LIMITS)).resolves.toBe(false);
    expect(await repo.openUploadGrants(userId, NOW)).toHaveLength(2);
  });

  it('frees an open slot when the grant is consumed, but not the issuance count', async () => {
    const first = grant();
    await repo.grantUpload(first, LIMITS);
    await repo.grantUpload(grant(), LIMITS);
    await repo.consumeUploadGrant(userId, first.assetId);

    expect(await repo.openUploadGrants(userId, NOW)).toHaveLength(1);
    // Two holdings plus one still counts against the issuance window of three.
    await expect(repo.grantUpload(grant(), LIMITS)).resolves.toBe(true);
    await expect(repo.grantUpload(grant(), LIMITS)).resolves.toBe(false);
  });

  it('stops counting a grant against the open limit once its URL expires', async () => {
    await repo.grantUpload(grant(), LIMITS);
    await repo.grantUpload(grant(), LIMITS);
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);

    expect(await repo.openUploadGrants(userId, later)).toHaveLength(0);
  });

  it('counts issuance per account', async () => {
    const other = 'usr_2';
    for (let issued = 0; issued < 3; issued += 1) {
      await repo.grantUpload(grant(), LIMITS);
    }
    expect(await repo.grantUpload(grant(), LIMITS)).toBe(false);

    minted = 0;
    const otherGrant = { ...grant(), userId: other };
    await expect(
      repo.grantUpload(
        {
          ...otherGrant,
          objectKey: avatarObjectKey(other, otherGrant.assetId),
        },
        LIMITS,
      ),
    ).resolves.toBe(true);
  });

  it('consuming a grant that is not there is not an error', async () => {
    await expect(
      repo.consumeUploadGrant(userId, 'ava_01J00000000000000000000099'),
    ).resolves.toBeUndefined();
  });
}
