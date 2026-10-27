import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import {
  type ApiKeyNearExpiryNoticeRecordPort,
  type ApiKeyNearExpirySweepSummary,
  SweepApiKeyNearExpiry,
} from '@/modules/identity/public/api-key-near-expiry-sweep';

import { runOperatorCommand } from './operator-command-context';

type ClosableRecords = ApiKeyNearExpiryNoticeRecordPort & {
  close(): Promise<void>;
};

export interface NotificationsSweepCliInput {
  readonly databaseUrl: string;
  readonly records?: ClosableRecords;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

async function openRecords(
  input: NotificationsSweepCliInput,
): Promise<ClosableRecords> {
  if (input.records !== undefined) return input.records;
  const { createOperatorNotificationClient } = await import(
    './operator-notification-client'
  );
  return createOperatorNotificationClient(input.databaseUrl);
}

/**
 * Records a Notification Event for each API key expiring within 14 days and
 * queues its email (ADR-0120). It prints one JSON line of counts and never a
 * key, name, or address. Run it once a day per deployment.
 */
export async function runNotificationsSweepCommand(
  input: NotificationsSweepCliInput,
): Promise<ApiKeyNearExpirySweepSummary> {
  const emit = input.emit ?? console.log;
  const records = await openRecords(input);
  const sweep = new SweepApiKeyNearExpiry(records, prefixedIdGenerator('nev_'));

  const { result } = await runOperatorCommand(
    records,
    input.now,
    ({ occurredAt }) => sweep.run(occurredAt),
  );

  emit(JSON.stringify(result));
  return result;
}
