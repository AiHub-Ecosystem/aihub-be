import type {
  PostgresIdentityQueryClient,
  PostgresIdentityTransactionalClient,
} from '@/modules/identity/infrastructure/postgres-identity.client';
import { createPostgresIdentityClient } from '@/modules/identity/infrastructure/postgres-identity.client';

export interface QueryPause {
  readonly captured: Promise<void>;
  release(): void;
}

interface ArmedPause {
  readonly fragment: string | undefined;
  readonly captured: () => void;
  readonly released: Promise<void>;
  release(): void;
}

async function backendPidOf(
  client: PostgresIdentityQueryClient,
): Promise<number | undefined> {
  const rows = await client.query('SELECT pg_backend_pid() AS pid', []);
  const first = rows[0];
  if (typeof first !== 'object' || first === null) {
    return undefined;
  }
  const pid = (first as { pid?: unknown }).pid;
  return typeof pid === 'number' ? pid : undefined;
}

/**
 * A real identity client that can be held open immediately after one statement
 * returns.
 *
 * This exists so a test can place a second connection on the far side of a row
 * lock and prove the lock is what stopped it. Waiting and then asserting would
 * only ever pass in the green direction: an implementation that never locked but
 * happened to be slow would look identical.
 *
 * The hold happens on the statement's own connection. Inside a transaction that
 * is the transaction's connection, which is the whole point: holding a pool
 * connection instead would take the lock outside the transaction and prove
 * nothing.
 */
export class PausingIdentityClient
  implements PostgresIdentityQueryClient, PostgresIdentityTransactionalClient
{
  private pause: ArmedPause | undefined;
  private heldBackendPid: number | undefined;

  constructor(
    private readonly client: ReturnType<typeof createPostgresIdentityClient>,
  ) {}

  /**
   * The backend of the connection currently held open by a pause.
   *
   * Read from the held connection itself rather than by looking for whichever
   * backend happens to be sitting in a transaction, so a second session on the
   * same database cannot be mistaken for it.
   */
  heldBackend(): Promise<number | undefined> {
    return Promise.resolve(this.heldBackendPid);
  }

  pauseAfterNextQuery(): QueryPause {
    return this.arm(undefined);
  }

  /**
   * Holds after the first statement whose text contains `fragment`.
   *
   * Use this when the statement you want to pause behind matters. Pausing after
   * the first statement of a mutation would hold it before the transaction
   * opens, which says nothing about a row lock.
   */
  pauseAfterQueryContaining(fragment: string): QueryPause {
    return this.arm(fragment);
  }

  /**
   * Drops an armed hold without running it.
   *
   * A test that gives up before its statement was reached would otherwise leave
   * the hold armed, and the next statement in the file would be the one that
   * waits.
   */
  disarm(): void {
    this.pause?.release();
    this.pause = undefined;
  }

  private arm(fragment: string | undefined): QueryPause {
    let markCaptured: () => void = () => undefined;
    let markReleased: () => void = () => undefined;
    const captured = new Promise<void>((resolve) => {
      markCaptured = resolve;
    });
    const released = new Promise<void>((resolve) => {
      markReleased = resolve;
    });
    const pause: ArmedPause = {
      fragment,
      captured: markCaptured,
      released,
      release: markReleased,
    };
    this.pause = pause;
    return { captured, release: markReleased };
  }

  async query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly unknown[]> {
    const rows = await this.client.query(text, values);
    await this.holdIfArmed(text, this.client);
    return rows;
  }

  async transaction<T>(
    callback: (client: PostgresIdentityQueryClient) => Promise<T>,
  ): Promise<T> {
    const result = await this.client.transaction((client) =>
      callback({
        query: async (text, values) => {
          const rows = await client.query(text, values);
          await this.holdIfArmed(text, client);
          return rows;
        },
      }),
    );
    return result;
  }

  private async holdIfArmed(
    text: string,
    onConnection: PostgresIdentityQueryClient,
  ): Promise<void> {
    const pause = this.pause;
    if (pause === undefined) {
      return;
    }
    if (pause.fragment !== undefined && !text.includes(pause.fragment)) {
      return;
    }
    this.pause = undefined;
    const pid = await backendPidOf(onConnection);
    this.heldBackendPid = pid;
    pause.captured();
    await pause.released;
    this.heldBackendPid = undefined;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

export async function waitForQueryCapture(
  pause: QueryPause,
  timeoutMs = 2_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pause.captured,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('the paused statement did not return')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
