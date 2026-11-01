import { requireOwnedSpeakingResults } from './require-owned-speaking-results';
import type {
  SpeakingV2ResultOwner,
  SpeakingV2ResultOwnershipPort,
} from './speaking-v2-result-ownership.port';

const owner: SpeakingV2ResultOwner = {
  organizationId: 'org',
  environment: 'production',
  endUserId: 'User-1',
};

function ownershipOf(...owned: string[]): SpeakingV2ResultOwnershipPort {
  return {
    record: async () => undefined,
    findOwnedIds: async (_owner, _kind, ids) =>
      ids.filter((id) => owned.includes(id)),
  };
}

describe('requireOwnedSpeakingResults', () => {
  it('passes when every id is owned, including a repeated id', async () => {
    await expect(
      requireOwnedSpeakingResults(ownershipOf('a', 'b'), owner, 'part', [
        'a',
        'b',
        'a',
      ]),
    ).resolves.toBeUndefined();
  });

  it('refuses the whole request when one id is missing, without naming it', async () => {
    const failure = await requireOwnedSpeakingResults(
      ownershipOf('a'),
      owner,
      'response',
      ['a', 'secret-foreign-id'],
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect(String((failure as Error).message)).not.toContain(
      'secret-foreign-id',
    );
  });
});
