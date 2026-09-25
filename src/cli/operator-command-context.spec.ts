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
});
