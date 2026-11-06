import {
  LogicalReplicationService,
  type Pgoutput,
  PgoutputPlugin,
  type ReplicationClientConfig,
} from 'pg-logical-replication';
import { ulid } from 'ulid';

import { PostgresEmailDeliveryRequestRepository } from '@/modules/auth/email-delivery/infrastructure/postgres-email-delivery-request.repository';
import { EmailDeliveryTransactionAdapter } from '@/modules/auth/shared/infrastructure/email-delivery-transaction.adapter';
import { createFixturePrismaClient } from '@/modules/persistence/infrastructure/prisma-client';
import { createTestPool, testDatabaseUrl } from '../shared/database';

interface CommittedMessage {
  readonly id: string;
  readonly endLsn: string;
}

function listen(slot: string, publication: string) {
  const service = new LogicalReplicationService(
    {
      connectionString: testDatabaseUrl(),
      replication: 'database',
      application_name: 'aihub-email-wal-test',
    } as ReplicationClientConfig,
    {
      acknowledge: { auto: false, timeoutSeconds: 0 },
      flowControl: { enabled: true },
    },
  );
  const pending = new Map<
    string,
    (message: CommittedMessage | undefined) => void
  >();
  const received = new Map<string, CommittedMessage>();
  let ids: string[] = [];
  service.on('data', async (_lsn, message: Pgoutput.Message) => {
    if (message.tag === 'begin') {
      ids = [];
    } else if (
      message.tag === 'message' &&
      message.prefix === 'aihub_email_delivery' &&
      message.transactional
    ) {
      ids.push(Buffer.from(message.content).toString('utf8'));
    } else if (message.tag === 'commit' && message.commitEndLsn !== null) {
      for (const id of ids) {
        const committed = { id, endLsn: message.commitEndLsn };
        const resolve = pending.get(id);
        if (resolve === undefined) received.set(id, committed);
        else resolve(committed);
      }
      ids = [];
    }
  });
  const started = new Promise<void>((resolve) => service.on('start', resolve));
  const subscription = service.subscribe(
    new PgoutputPlugin({
      protoVersion: 1,
      publicationNames: [publication],
      messages: true,
    }),
    slot,
  );
  void subscription.catch(() => undefined);

  return {
    service,
    async start() {
      await Promise.race([
        started,
        subscription.then(() => {
          throw new Error('logical replication ended before starting');
        }),
      ]);
    },
    waitFor(
      id: string,
      timeoutMs = 10_000,
    ): Promise<CommittedMessage | undefined> {
      const existing = received.get(id);
      if (existing !== undefined) {
        received.delete(id);
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(undefined);
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        });
      });
    },
    async close() {
      await service.stop();
      await subscription.catch(() => undefined);
      await service.destroy();
    },
  };
}

describe('email delivery logical messages', () => {
  it('emits only committed requests and replays until the consumer acknowledges the commit', async () => {
    const pool = createTestPool();
    const prisma = createFixturePrismaClient(testDatabaseUrl());
    const suffix = ulid().toLowerCase();
    const publication = `aihub_email_wal_${suffix}`;
    const slot = `aihub_email_wal_${suffix}`;
    const repository = new PostgresEmailDeliveryRequestRepository();
    const rolledBackId = `edr_${ulid()}`;
    const committedId = `edr_${ulid()}`;
    let slotCreated = false;
    let publicationCreated = false;
    let first: ReturnType<typeof listen> | undefined;
    let replay: ReturnType<typeof listen> | undefined;
    let afterAck: ReturnType<typeof listen> | undefined;

    try {
      const settings = await pool.query<{ wal_level: string }>(
        `SELECT current_setting('wal_level') AS wal_level`,
      );
      expect(settings.rows[0]?.wal_level).toBe('logical');
      await pool.query(`CREATE PUBLICATION ${publication}`);
      publicationCreated = true;
      await pool.query('SELECT pg_create_logical_replication_slot($1, $2)', [
        slot,
        'pgoutput',
      ]);
      slotCreated = true;
      first = listen(slot, publication);
      await first.start();

      await expect(
        prisma.$transaction(async (transaction) => {
          await repository.insert(
            new EmailDeliveryTransactionAdapter(transaction),
            {
              id: rolledBackId,
              kind: 'verification_email',
              payloadCiphertext: 'sealed',
              createdAt: new Date(),
            },
          );
          throw new Error('rollback request');
        }),
      ).rejects.toThrow('rollback request');
      expect(await first.waitFor(rolledBackId, 300)).toBeUndefined();

      await prisma.$transaction((transaction) =>
        repository.insert(new EmailDeliveryTransactionAdapter(transaction), {
          id: committedId,
          kind: 'verification_email',
          payloadCiphertext: 'sealed',
          createdAt: new Date(),
        }),
      );
      const firstDelivery = await first.waitFor(committedId);
      expect(firstDelivery).toMatchObject({ id: committedId });
      await first.close();
      first = undefined;

      replay = listen(slot, publication);
      await replay.start();
      const replayed = await replay.waitFor(committedId);
      expect(replayed).toMatchObject({ id: committedId });
      if (replayed === undefined) throw new Error('email WAL replay missing');
      await replay.service.acknowledge(replayed.endLsn);
      await replay.close();
      replay = undefined;

      afterAck = listen(slot, publication);
      await afterAck.start();
      expect(await afterAck.waitFor(committedId, 300)).toBeUndefined();
    } finally {
      await afterAck?.close();
      await replay?.close();
      await first?.close();
      await prisma.emailDeliveryRequest.deleteMany({
        where: { id: { in: [rolledBackId, committedId] } },
      });
      if (slotCreated) {
        await pool.query('SELECT pg_drop_replication_slot($1)', [slot]);
      }
      if (publicationCreated)
        await pool.query(`DROP PUBLICATION ${publication}`);
      await prisma.$disconnect();
      await pool.end();
    }
  }, 30_000);
});
