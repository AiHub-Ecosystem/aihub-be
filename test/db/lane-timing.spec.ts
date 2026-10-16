import { timeDatabasePhase } from './lane-timing';

describe('database lane phase failures', () => {
  it('names the failed phase and redacts database credentials', async () => {
    const log = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await expect(
        timeDatabasePhase('test database cleanup', async () => {
          throw new Error(
            'connection failed: postgres://user:secret@localhost:5432/aihub',
          );
        }),
      ).rejects.toThrow(
        'test database cleanup failed: connection failed: <redacted database URL>',
      );
    } finally {
      log.mockRestore();
    }
  });
});
