import { type ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';

import type { Pool } from 'pg';

import { createTestPool, testDatabaseUrl } from '../shared/database';
import {
  PROTOTYPE_LEASE_TTL_MS,
  PROTOTYPE_SCHEMA,
  acquireFencingToken,
  createFencingPrototype,
  readProtectedValue,
  writeProtectedValue,
} from './fencing-token-prototype';

const RESOURCE_ID = 'grading-batch-1';

interface AcquiredMessage {
  readonly type: 'acquired';
  readonly token: string;
}

interface SettledMessage {
  readonly type: 'settled';
  readonly leaseLostDetected: boolean;
  readonly currentOwner: string | null;
  readonly currentToken: string | null;
  readonly staleWriteRows: number;
  readonly cancelled: boolean;
  readonly localWorkJoined: boolean;
  readonly subsequentSideEffects: number;
}

type WorkerMessage =
  | AcquiredMessage
  | SettledMessage
  | { readonly type: 'failure'; readonly errorCode: string };

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    typeof value.type !== 'string'
  ) {
    return false;
  }
  switch (value.type) {
    case 'acquired':
      return 'token' in value && typeof value.token === 'string';
    case 'settled':
      return (
        'leaseLostDetected' in value &&
        typeof value.leaseLostDetected === 'boolean' &&
        'currentOwner' in value &&
        (value.currentOwner === null ||
          typeof value.currentOwner === 'string') &&
        'currentToken' in value &&
        (value.currentToken === null ||
          typeof value.currentToken === 'string') &&
        'staleWriteRows' in value &&
        typeof value.staleWriteRows === 'number' &&
        'cancelled' in value &&
        typeof value.cancelled === 'boolean' &&
        'localWorkJoined' in value &&
        typeof value.localWorkJoined === 'boolean' &&
        'subsequentSideEffects' in value &&
        typeof value.subsequentSideEffects === 'number'
      );
    case 'failure':
      return 'errorCode' in value && typeof value.errorCode === 'string';
    default:
      return false;
  }
}

function waitForMessage(
  worker: ChildProcess,
  type: 'acquired',
): Promise<AcquiredMessage>;
function waitForMessage(
  worker: ChildProcess,
  type: 'settled',
): Promise<SettledMessage>;
function waitForMessage(
  worker: ChildProcess,
  type: 'acquired' | 'settled',
): Promise<AcquiredMessage | SettledMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`paused worker did not send ${type}`));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = (message: unknown) => {
      if (!isWorkerMessage(message)) return;
      if (message.type === 'failure') {
        cleanup();
        reject(new Error(`paused worker failed (${message.errorCode})`));
      } else if (message.type === type) {
        cleanup();
        resolve(message);
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error('paused worker could not start'));
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`paused worker exited before ${type} (${code})`));
    };

    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
  });
}

describe('PostgreSQL fencing token prototype', () => {
  let pool: Pool;
  let worker: ChildProcess | undefined;

  beforeAll(async () => {
    pool = createTestPool();
    await createFencingPrototype(pool, RESOURCE_ID);
  });

  afterAll(async () => {
    if (worker !== undefined && worker.exitCode === null) {
      const exited = once(worker, 'exit');
      worker.kill('SIGKILL');
      await exited.catch(() => undefined);
    }
    await pool.query(`DROP SCHEMA ${PROTOTYPE_SCHEMA} CASCADE`);
    await pool.end();
  });

  it('rejects the paused owner after takeover and joins its cancelled local work', async () => {
    worker = fork(
      join(__dirname, 'fencing-token-prototype.ts'),
      ['--paused-worker', RESOURCE_ID],
      {
        cwd: process.cwd(),
        execArgv: ['--import', 'tsx'],
        env: {
          ...process.env,
          FENCING_TEST_DATABASE_URL: testDatabaseUrl(),
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    const exited = once(worker, 'exit');
    const acquired = await waitForMessage(worker, 'acquired');

    expect(acquired.token).toBe('1');
    await expect(
      acquireFencingToken(
        pool,
        RESOURCE_ID,
        'worker-b',
        PROTOTYPE_LEASE_TTL_MS,
      ),
    ).resolves.toBeUndefined();

    await new Promise((resolve) =>
      setTimeout(resolve, PROTOTYPE_LEASE_TTL_MS + 200),
    );
    const newerToken = await acquireFencingToken(
      pool,
      RESOURCE_ID,
      'worker-b',
      10_000,
    );

    if (newerToken === undefined) {
      throw new Error('worker B did not acquire its lease');
    }
    expect(BigInt(newerToken)).toBeGreaterThan(BigInt(acquired.token));
    await expect(
      writeProtectedValue(pool, RESOURCE_ID, 'worker-b', newerToken),
    ).resolves.toBe(1);

    const settled = await waitForMessage(worker, 'settled');
    expect(settled).toMatchObject({
      leaseLostDetected: true,
      currentOwner: 'worker-b',
      currentToken: newerToken,
      staleWriteRows: 0,
      cancelled: true,
      localWorkJoined: true,
      subsequentSideEffects: 0,
    });
    await expect(readProtectedValue(pool, RESOURCE_ID)).resolves.toEqual({
      value: 'worker-b',
      fencingToken: newerToken,
    });
    await exited;
  });
});
