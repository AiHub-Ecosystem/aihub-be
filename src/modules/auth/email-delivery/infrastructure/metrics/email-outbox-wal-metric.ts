import { Gauge, type Registry } from '@prometheus-io/client';

export interface EmailOutboxWalSlotHealthSample {
  readonly active: boolean;
  readonly retainedBytes: number;
  readonly safeBytes: number | null;
  readonly status: 'reserved' | 'extended' | 'unreserved' | 'lost';
}

export function registerEmailOutboxWalMetric(registry: Registry) {
  let source:
    | (() => Promise<EmailOutboxWalSlotHealthSample | null>)
    | undefined;
  let pending: Promise<void> | undefined;
  const statuses = ['reserved', 'extended', 'unreserved', 'lost'] as const;
  function collect(): Promise<void> {
    if (source === undefined) return Promise.resolve();
    pending ??= (async () => {
      try {
        const sample = await source();
        readFailed.set(0);
        present.set(sample === null ? 0 : 1);
        active.set(sample?.active === true ? 1 : 0);
        retainedBytes.set(sample?.retainedBytes ?? 0);
        for (const status of statuses) {
          slotStatus.set({ status }, sample?.status === status ? 1 : 0);
        }
        slotStatus.set({ status: 'missing' }, sample === null ? 1 : 0);
        if (sample?.safeBytes === null || sample === null) safeBytes.reset();
        else safeBytes.set(sample.safeBytes);
      } catch {
        readFailed.set(1);
        present.reset();
        active.reset();
        retainedBytes.reset();
        safeBytes.reset();
        slotStatus.reset();
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  }
  const present = new Gauge({
    name: 'aihub_email_outbox_wal_slot_present',
    help: 'Whether the email outbox logical replication slot exists.',
    registers: [registry],
    collect,
  });
  const active = new Gauge({
    name: 'aihub_email_outbox_wal_slot_active',
    help: 'Whether a consumer currently uses the email outbox slot.',
    registers: [registry],
    collect,
  });
  const retainedBytes = new Gauge({
    name: 'aihub_email_outbox_wal_retained_bytes',
    help: 'WAL bytes retained by the email outbox slot.',
    registers: [registry],
    collect,
  });
  const safeBytes = new Gauge({
    name: 'aihub_email_outbox_wal_safe_bytes',
    help: 'WAL bytes remaining before the email outbox slot can be lost.',
    registers: [registry],
    collect,
  });
  const slotStatus = new Gauge({
    name: 'aihub_email_outbox_wal_slot_status',
    help: 'Email outbox slot state, one for the active PostgreSQL status.',
    labelNames: ['status'],
    registers: [registry],
    collect,
  });
  const readFailed = new Gauge({
    name: 'aihub_email_outbox_wal_health_read_failed',
    help: 'Whether the latest email WAL slot health read failed.',
    registers: [registry],
    collect,
  });

  return {
    setSource(next: typeof source): void {
      source = next;
      if (next === undefined) {
        present.reset();
        active.reset();
        retainedBytes.reset();
        safeBytes.reset();
        slotStatus.reset();
        readFailed.reset();
      }
    },
  };
}
