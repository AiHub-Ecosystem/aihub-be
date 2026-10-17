import { join } from 'node:path';

interface LaneClient {
  connect(): Promise<void>;
  query(
    query: string,
    values: readonly number[],
  ): Promise<{ rows: readonly { acquired: boolean }[] }>;
  end(): Promise<void>;
}

interface DatabaseLaneRunner {
  databaseLaneLockConnectionString(adminUrl: string): string;
  runDatabaseLane(
    lane: 'db' | 'tenant-isolation',
    options: {
      client: LaneClient;
      env: NodeJS.ProcessEnv;
      passthrough?: readonly string[];
      runCommand: (command: string, args: string[]) => Promise<number>;
    },
  ): Promise<number>;
  safeErrorMessage(error: unknown): string;
  withDatabaseLaneLock<T>(
    client: LaneClient,
    run: () => Promise<T>,
  ): Promise<T>;
}

const runner = require(
  join(process.cwd(), 'scripts/checks/db-lane/run-database-lane.cjs'),
) as DatabaseLaneRunner;

function laneClient(acquired: boolean) {
  let ended = false;
  const client: LaneClient = {
    async connect() {},
    async query() {
      return { rows: [{ acquired }] };
    },
    async end() {
      ended = true;
    },
  };
  return { client, isEnded: () => ended };
}

describe('database validation lane runner', () => {
  it('claims the server through the maintenance database, outside the disposable test databases', () => {
    const lockUrl = new URL(
      runner.databaseLaneLockConnectionString(
        'postgres://aihub:change-me@localhost:5432/aihub_db_lane',
      ),
    );

    expect(lockUrl.pathname).toBe('/postgres');
    expect(lockUrl.host).toBe('localhost:5432');
  });

  it('refuses before running tests when another session holds the lane', async () => {
    const { client, isEnded } = laneClient(false);
    const run = jest.fn<Promise<string>, []>().mockResolvedValue('ran');

    await expect(
      runner.withDatabaseLaneLock(client, run),
    ).rejects.toMatchObject({
      code: 'DB_LANE_HELD',
      message: 'Database validation lane is already held',
    });

    expect(run).not.toHaveBeenCalled();
    expect(isEnded()).toBe(true);
  });

  it('returns Jest’s exit code and closes the lock session after the run', async () => {
    const { client, isEnded } = laneClient(true);
    const exitCodes = [0, 17];
    const commands: string[][] = [];
    const runCommand = async (_command: string, args: string[]) => {
      commands.push(args);
      return exitCodes.shift() ?? 1;
    };

    await expect(
      runner.runDatabaseLane('db', {
        client,
        env: {},
        passthrough: [],
        runCommand,
      }),
    ).resolves.toBe(17);

    expect(commands).toHaveLength(2);
    expect(commands[1]?.[0]).toMatch(/[\\/]jest[\\/]bin[\\/]jest\.js$/);
    expect(commands[1]?.slice(1)).toEqual([
      '--config',
      expect.stringContaining('jest.config.db.cjs'),
      '--runInBand',
    ]);
    expect(isEnded()).toBe(true);
  });

  it('stops after a failed Prisma generation and preserves its exit code', async () => {
    const { client, isEnded } = laneClient(true);
    const runCommand = jest
      .fn<Promise<number>, [string, string[]]>()
      .mockResolvedValue(23);

    await expect(
      runner.runDatabaseLane('tenant-isolation', {
        client,
        env: {},
        runCommand,
      }),
    ).resolves.toBe(23);

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(isEnded()).toBe(true);
  });
});

describe('safeErrorMessage', () => {
  it('never returns an empty message for an AggregateError', () => {
    const error = new AggregateError(
      [new Error('connect ECONNREFUSED 127.0.0.1:5432')],
      '',
    );
    (error as { code?: string }).code = 'ECONNREFUSED';

    const message = runner.safeErrorMessage(error);

    expect(message.length).toBeGreaterThan(0);
    expect(message).toContain('ECONNREFUSED');
    expect(message).toContain('connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('reports every underlying reason of an aggregate failure', () => {
    const error = new AggregateError(
      [
        new Error('connect ECONNREFUSED 127.0.0.1:5432'),
        new Error('connect ECONNREFUSED ::1:5432'),
      ],
      '',
    );

    const message = runner.safeErrorMessage(error);

    expect(message).toContain('connect ECONNREFUSED 127.0.0.1:5432');
    expect(message).toContain('connect ECONNREFUSED ::1:5432');
  });

  it('reports a code and message when only a code is present', () => {
    const error = new Error('');
    (error as { code?: string }).code = 'ECONNREFUSED';

    expect(runner.safeErrorMessage(error)).toContain('ECONNREFUSED');
  });

  it('prints something when there is no message at all', () => {
    expect(runner.safeErrorMessage(new Error(''))).not.toBe('');
    expect(runner.safeErrorMessage(undefined)).not.toBe('');
  });

  it('redacts database URLs in every part of the failure', () => {
    const error = new AggregateError(
      [
        new Error(
          'connect failed to postgres://aihub:secret@db.example.com:5432/aihub',
        ),
      ],
      'postgres://aihub:secret@db.example.com:5432/aihub refused',
    );

    const message = runner.safeErrorMessage(error);

    expect(message).not.toContain('secret');
    expect(message).not.toContain('db.example.com');
    expect(message).toContain('<redacted database URL>');
  });

  it('distinguishes an authentication failure by its code', () => {
    const error = new Error('password authentication failed for user "aihub"');
    (error as { code?: string }).code = '28P01';

    const message = runner.safeErrorMessage(error);

    expect(message).toContain('28P01');
    expect(message).toContain('password authentication failed');
  });
});
