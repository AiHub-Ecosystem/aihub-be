import { insertRefreshSession } from '@/modules/auth/local-credentials/infrastructure/local-auth-statements';
import { insertWebSession } from '@/modules/auth/web-sessions/infrastructure/web-session-statements';
import type { Prisma } from '@prisma-client/client';
import { admitSessionContinuation } from './auth-mfa-session.guard';

const refreshToken = {
  id: 'rft_01J00000000000000000000000',
  familyId: 'rfs_01J00000000000000000000000',
  raw: 'raw',
  hash: 'a'.repeat(64),
  expiresAt: new Date(0),
};
const refreshRow = {
  userId: 'usr_1',
  token: refreshToken,
  issuedAt: new Date(0),
};
const webRow = {
  id: 'wbs_1',
  userId: 'usr_1',
  tokenHash: 'a'.repeat(64),
  createdAt: new Date(0),
  expiresAt: new Date(1),
};

function clientThatStores() {
  const refreshCreate = jest.fn(async () => ({}));
  const webCreate = jest.fn(async () => ({}));
  const client = {
    refreshToken: { create: refreshCreate },
    webSession: { create: webCreate },
  } as unknown as Prisma.TransactionClient;
  return { client, refreshCreate, webCreate };
}

describe('a session insert', () => {
  it('stores the session for the account its admission names', async () => {
    const { client, refreshCreate, webCreate } = clientThatStores();
    const admission = admitSessionContinuation('usr_1');

    await insertRefreshSession(client, refreshRow, admission);
    await insertWebSession(client, webRow, admission);

    expect(refreshCreate).toHaveBeenCalledTimes(1);
    expect(webCreate).toHaveBeenCalledTimes(1);
  });

  it('refuses an admission minted for another account, and stores nothing', async () => {
    const { client, refreshCreate, webCreate } = clientThatStores();
    const admission = admitSessionContinuation('usr_other');

    await expect(
      insertRefreshSession(client, refreshRow, admission),
    ).rejects.toThrow('session admission belongs to another account');
    await expect(insertWebSession(client, webRow, admission)).rejects.toThrow(
      'session admission belongs to another account',
    );
    expect(refreshCreate).not.toHaveBeenCalled();
    expect(webCreate).not.toHaveBeenCalled();
  });

  // These checks run in `bun run type-check`: each marked line must fail to
  // compile, so a new path that stores a session cannot skip the second-factor
  // check that mints a SessionAdmission. The attempts are never called.
  it('does not compile without the admission the second-factor check mints', () => {
    const { client } = clientThatStores();
    const attempts = [
      () =>
        // @ts-expect-error a Refresh Session insert needs a SessionAdmission
        insertRefreshSession(client, refreshRow),
      () =>
        // @ts-expect-error a Web Session insert needs a SessionAdmission
        insertWebSession(client, webRow),
      () =>
        // @ts-expect-error an empty object is not an admission
        insertRefreshSession(client, refreshRow, {}),
    ];

    expect(attempts).toBeDefined();
  });
});
