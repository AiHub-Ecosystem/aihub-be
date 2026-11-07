import {
  type OperatorCommandContext,
  runOperatorCommand,
} from './operator-command-context';

class Repository {
  closed = false;

  async close(): Promise<void> {
    this.closed = true;
  }
}

class Storage {
  closed = 0;
  fails = false;

  async close(): Promise<void> {
    this.closed += 1;
    if (this.fails) {
      throw new Error('storage destroy failed');
    }
  }
}

describe('runOperatorCommand', () => {
  it('captures the request id and clock once and closes the repository', async () => {
    const repository = new Repository();
    const now = jest
      .fn<Date, []>()
      .mockReturnValue(new Date('2026-09-23T10:00:00.000Z'));
    const contexts: OperatorCommandContext[] = [];

    const execution = await runOperatorCommand(
      repository,
      now,
      async (context) => {
        contexts.push(context);
        return 'done';
      },
    );

    expect(execution.result).toBe('done');
    expect(now).toHaveBeenCalledTimes(1);
    expect(contexts[0]?.occurredAt).toEqual(
      new Date('2026-09-23T10:00:00.000Z'),
    );
    expect(contexts[0]?.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(repository.closed).toBe(true);
  });

  it('closes the repository when the operation fails', async () => {
    const repository = new Repository();

    await expect(
      runOperatorCommand(repository, undefined, async () => {
        throw new Error('command failed');
      }),
    ).rejects.toThrow('command failed');

    expect(repository.closed).toBe(true);
  });

  it('closes the repository when clock capture fails', async () => {
    const repository = new Repository();

    await expect(
      runOperatorCommand(
        repository,
        () => {
          throw new Error('clock failed');
        },
        async () => 'unused',
      ),
    ).rejects.toThrow('clock failed');

    expect(repository.closed).toBe(true);
  });

  it('closes the storage before the repository on success', async () => {
    const repository = new Repository();
    const storage = new Storage();
    const order: string[] = [];
    const originalStorageClose = storage.close.bind(storage);
    const originalRepositoryClose = repository.close.bind(repository);
    storage.close = async () => {
      order.push('storage');
      await originalStorageClose();
    };
    repository.close = async () => {
      order.push('repository');
      await originalRepositoryClose();
    };

    await runOperatorCommand(
      repository,
      undefined,
      async () => 'done',
      storage,
    );

    expect(order).toEqual(['storage', 'repository']);
    expect(storage.closed).toBe(1);
  });

  it('closes the storage when the operation fails', async () => {
    const repository = new Repository();
    const storage = new Storage();

    await expect(
      runOperatorCommand(
        repository,
        undefined,
        async () => {
          throw new Error('command failed');
        },
        storage,
      ),
    ).rejects.toThrow('command failed');

    expect(repository.closed).toBe(true);
    expect(storage.closed).toBe(1);
  });

  it('keeps the operation error when the storage close also fails', async () => {
    const repository = new Repository();
    const storage = new Storage();
    storage.fails = true;

    await expect(
      runOperatorCommand(
        repository,
        undefined,
        async () => {
          throw new Error('command failed');
        },
        storage,
      ),
    ).rejects.toThrow('command failed');

    // The failed destroy attempt still happened; the original error wins.
    expect(repository.closed).toBe(true);
  });

  it('surfaces a storage destroy failure as the command error on success', async () => {
    const repository = new Repository();
    const storage = new Storage();
    storage.fails = true;

    await expect(
      runOperatorCommand(repository, undefined, async () => 'done', storage),
    ).rejects.toThrow('storage destroy failed');

    expect(repository.closed).toBe(true);
  });

  it('runs without a closable storage', async () => {
    const repository = new Repository();

    const execution = await runOperatorCommand(
      repository,
      undefined,
      async () => 'done',
    );

    expect(execution.result).toBe('done');
    expect(repository.closed).toBe(true);
  });
});
