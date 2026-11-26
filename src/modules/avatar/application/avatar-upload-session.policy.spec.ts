import { avatarUploadSessionPolicy } from './avatar-upload-session.policy';

const ASSET = 'ava_01J00000000000000000000001';
const USER = 'usr_01J00000000000000000000000';

describe('avatarUploadSessionPolicy', () => {
  it('derives a user-only owner and one Avatar object key', () => {
    const policy = avatarUploadSessionPolicy();
    const owner = policy.owner({ userId: USER } as never, ASSET);

    expect(owner).toMatchObject({ assetId: ASSET, endUserId: USER });
    expect(owner.organizationId).toBeUndefined();
    expect(policy.stagingKey(owner)).toBe(
      `users/${USER}/avatar/${ASSET}/original`,
    );
    expect(policy.publishedKey(owner)).toBe(policy.stagingKey(owner));
  });
});
