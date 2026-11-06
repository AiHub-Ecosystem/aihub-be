import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  LogicalReplicationService,
  type Pgoutput,
  PgoutputPlugin,
  type ReplicationClientConfig,
} from 'pg-logical-replication';

import {
  backgroundWorkSettled,
  backgroundWorkStarted,
} from '@/common/background-work-tracker';
import { AppError } from '@/common/errors/app-error';
import type { EmailDispatchStorePort } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { EmailDeliveryPoller } from '@/modules/auth/email-delivery/application/poller/email-delivery-poller';
import { EmailOutboxPollerScheduler } from '@/modules/auth/email-delivery/infrastructure/email-outbox-poller.scheduler';
import {
  EMAIL_DELIVERY_WAL_MESSAGE_PREFIX,
  EMAIL_DELIVERY_WAL_PUBLICATION,
} from './email-delivery-wal.constants';

const RECONNECT_DELAY_MS = 5_000;
const DISPATCH_BATCH_WINDOW_MS = 100;
const RECONCILE_PAGE_SIZE = 100;
const MAX_PENDING_CHECKPOINTS = 1_000;
const MAX_PENDING_REQUESTS = 500;
const EMAIL_REQUEST_ID = /^edr_[0-9A-HJKMNP-TV-Z]{26}$/;

interface WalCheckpoint {
  readonly lsn: string;
  remaining: number;
  complete: boolean;
}

export interface EmailOutboxWalConsumerOptions {
  readonly enabled?: boolean;
  readonly replicationUrl: string;
  readonly store: EmailDispatchStorePort;
  readonly scheduler: EmailOutboxPollerScheduler;
  readonly slotName: string;
  readonly readConfirmedLsn: () => Promise<string | null>;
}

@Injectable()
export class EmailOutboxWalConsumer
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(EmailOutboxWalConsumer.name);
  private readonly checkpoints: WalCheckpoint[] = [];
  private readonly requestCheckpoints = new Map<string, WalCheckpoint[]>();
  private readonly requestTimers = new Map<string, NodeJS.Timeout>();
  private readonly activeRequests = new Set<string>();
  private readonly pendingDispatchIds = new Set<string>();
  private stopped = false;
  private running: Promise<void> | undefined;
  private service: LogicalReplicationService | undefined;
  private acknowledging: Promise<void> = Promise.resolve();
  private lastAcknowledgedLsn: string | undefined;
  private connectionFailureReported = false;
  private dispatchTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: EmailOutboxWalConsumerOptions) {}

  onModuleInit(): void {
    if (this.options.enabled === false) return;
    this.running = this.consume();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    for (const timer of this.requestTimers.values()) clearTimeout(timer);
    this.requestTimers.clear();
    if (this.dispatchTimer !== undefined) clearTimeout(this.dispatchTimer);
    await this.service?.stop();
    await this.running;
  }

  private async consume(): Promise<void> {
    while (!this.stopped) {
      const clientConfig: ReplicationClientConfig = {
        connectionString: this.options.replicationUrl,
        replication: 'database',
        application_name: 'aihub-email-delivery-wal',
        keepAlive: true,
      };
      const service = new LogicalReplicationService(clientConfig, {
        acknowledge: { auto: false, timeoutSeconds: 0 },
        flowControl: { enabled: true },
      });
      this.service = service;
      let initialize: Promise<void> | undefined;
      let ids: string[] = [];
      service.on('start', () => {
        this.connectionFailureReported = false;
        initialize = this.reconcileQueuedRequests();
        void initialize.catch(() => service.stop());
      });
      service.on('error', () => {
        if (this.connectionFailureReported) return;
        this.connectionFailureReported = true;
        this.logger.error({ event: 'email_outbox_wal_connection_failed' });
      });
      service.on('heartbeat', (_lsn, _timestamp, shouldRespond) => {
        const acknowledgedLsn = this.lastAcknowledgedLsn;
        if (shouldRespond && acknowledgedLsn !== undefined) {
          void this.acknowledgeKeepalive(service, acknowledgedLsn);
        }
      });
      service.on('data', async (_lsn, message: Pgoutput.Message) => {
        if (initialize === undefined) return;
        await initialize;
        if (message.tag === 'begin') {
          ids = [];
          return;
        }
        if (message.tag === 'message') {
          if (
            message.prefix === EMAIL_DELIVERY_WAL_MESSAGE_PREFIX &&
            message.transactional
          ) {
            const id = Buffer.from(message.content).toString('utf8');
            if (!EMAIL_REQUEST_ID.test(id)) {
              throw new AppError({
                code: 'INTERNAL_ERROR',
                message: 'Email delivery WAL request id is invalid',
                retryable: false,
              });
            }
            ids.push(id);
          }
          return;
        }
        if (message.tag !== 'commit') return;
        if (message.commitEndLsn === null) {
          throw new AppError({
            code: 'INTERNAL_ERROR',
            message: 'Email delivery WAL commit has no end LSN',
            retryable: false,
          });
        }
        while (
          !this.stopped &&
          (this.checkpoints.length >= MAX_PENDING_CHECKPOINTS ||
            this.requestCheckpoints.size >= MAX_PENDING_REQUESTS)
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, RECONNECT_DELAY_MS),
          );
        }
        const checkpoint: WalCheckpoint = {
          lsn: message.commitEndLsn,
          remaining: ids.length,
          complete: ids.length === 0,
        };
        this.checkpoints.push(checkpoint);
        for (const id of ids) {
          while (
            !this.stopped &&
            this.pendingRequestCount() >= MAX_PENDING_REQUESTS
          ) {
            await new Promise((resolve) =>
              setTimeout(resolve, RECONNECT_DELAY_MS),
            );
          }
          if (this.stopped) return;
          const entries = this.requestCheckpoints.get(id) ?? [];
          entries.push(checkpoint);
          this.requestCheckpoints.set(id, entries);
          this.enqueue(id);
        }
        ids = [];
        await this.acknowledgeCompleted();
      });

      try {
        this.lastAcknowledgedLsn =
          (await this.options.readConfirmedLsn()) ?? '0/00000000';
        await service.subscribe(
          new PgoutputPlugin({
            protoVersion: 1,
            publicationNames: [EMAIL_DELIVERY_WAL_PUBLICATION],
            messages: true,
          }),
          this.options.slotName,
        );
      } catch {
        // Reconnect below; never log a connection string or provider detail.
      } finally {
        await service.destroy();
        if (this.service === service) this.service = undefined;
      }
      if (!this.stopped) {
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
      }
    }
  }

  private async reconcileQueuedRequests(): Promise<void> {
    let afterId: string | undefined;
    for (;;) {
      const ids = await this.options.store.queuedIds({
        ...(afterId === undefined ? {} : { afterId }),
        limit: RECONCILE_PAGE_SIZE,
      });
      if (ids.length === 0) return;
      for (const id of ids) {
        while (
          !this.stopped &&
          this.pendingRequestCount() >= MAX_PENDING_REQUESTS
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, RECONNECT_DELAY_MS),
          );
        }
        if (this.stopped) return;
        this.enqueue(id);
      }
      afterId = ids[ids.length - 1];
      if (ids.length < RECONCILE_PAGE_SIZE) return;
    }
  }

  private pendingRequestCount(): number {
    return (
      this.pendingDispatchIds.size +
      this.requestTimers.size +
      this.activeRequests.size
    );
  }

  private enqueue(id: string): void {
    if (
      this.requestTimers.has(id) ||
      this.activeRequests.has(id) ||
      this.pendingDispatchIds.has(id)
    ) {
      return;
    }
    this.pendingDispatchIds.add(id);
    this.scheduleDispatchBatch();
  }

  private async dispatchBatch(): Promise<void> {
    if (this.stopped) return;
    const requestIds = [...this.pendingDispatchIds].slice(
      0,
      EmailDeliveryPoller.BATCH_SIZE,
    );
    for (const id of requestIds) {
      this.pendingDispatchIds.delete(id);
      this.activeRequests.add(id);
    }
    if (requestIds.length === 0) return;
    backgroundWorkStarted();
    try {
      await this.options.scheduler.dispatchRequests(requestIds);
      const states = await Promise.all(
        requestIds.map((id) => this.options.store.readDispatchState(id)),
      );
      for (const [index, id] of requestIds.entries()) {
        const state = states[index];
        if (this.stopped) continue;
        if (
          state !== null &&
          state !== undefined &&
          state.status !== 'queued'
        ) {
          this.completeRequest(id);
        } else {
          this.scheduleRetry(id, state ?? undefined);
        }
      }
    } catch {
      for (const id of requestIds) {
        if (!this.stopped) this.scheduleRetry(id);
      }
    } finally {
      for (const id of requestIds) this.activeRequests.delete(id);
      backgroundWorkSettled();
      if (this.pendingDispatchIds.size > 0) this.enqueueNextBatch();
    }
  }

  private enqueueNextBatch(): void {
    this.scheduleDispatchBatch();
  }

  private scheduleDispatchBatch(): void {
    if (this.dispatchTimer !== undefined || this.stopped) return;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = undefined;
      void this.dispatchBatch();
    }, DISPATCH_BATCH_WINDOW_MS);
    this.dispatchTimer.unref();
  }

  private scheduleRetry(
    id: string,
    state?: Awaited<ReturnType<EmailDispatchStorePort['readDispatchState']>>,
  ): void {
    const now = Date.now();
    const retryDelay =
      state?.attempts === 1 ? 60_000 : state?.attempts === 2 ? 300_000 : 0;
    const attemptDue =
      state?.lastAttemptAt === null || state?.lastAttemptAt === undefined
        ? now
        : state.lastAttemptAt.getTime() + retryDelay;
    const due = Math.max(
      now + RECONNECT_DELAY_MS,
      attemptDue,
      state?.leaseExpiresAt?.getTime() ?? now,
    );
    this.requestTimers.set(
      id,
      setTimeout(() => {
        this.requestTimers.delete(id);
        this.enqueue(id);
      }, due - now),
    );
  }

  private completeRequest(id: string): void {
    const checkpoints = this.requestCheckpoints.get(id) ?? [];
    this.requestCheckpoints.delete(id);
    for (const checkpoint of checkpoints) {
      checkpoint.remaining -= 1;
      checkpoint.complete = checkpoint.remaining === 0;
    }
    void this.acknowledgeCompleted();
  }

  private async acknowledgeCompleted(): Promise<void> {
    this.acknowledging = this.acknowledging
      .then(() => this.flushAcknowledgements())
      .catch(() => undefined);
    await this.acknowledging;
  }

  private async acknowledgeKeepalive(
    service: LogicalReplicationService,
    lsn: string,
  ): Promise<void> {
    this.acknowledging = this.acknowledging
      .then(() =>
        this.service === service
          ? service.acknowledge(lsn).then(() => undefined)
          : undefined,
      )
      .catch(() => undefined);
    await this.acknowledging;
  }

  private async flushAcknowledgements(): Promise<void> {
    const service = this.service;
    if (service === undefined) return;
    while (this.checkpoints[0]?.complete === true) {
      const checkpoint = this.checkpoints[0];
      if (!(await service.acknowledge(checkpoint.lsn))) return;
      this.lastAcknowledgedLsn = checkpoint.lsn;
      this.checkpoints.shift();
    }
  }
}
