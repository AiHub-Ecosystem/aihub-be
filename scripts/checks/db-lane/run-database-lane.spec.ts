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
      runCommand: (command: string, args: string[]) => Promise<number>;
    },
  ): Promise<number>;
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
