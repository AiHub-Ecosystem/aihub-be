import {
  ExpirePendingRegistrations,
  type PendingRegistrationExpirySummary,
  type PendingRegistrationRecordPort,
} from '@/modules/auth/public/pending-registration-expiry';

import { runOperatorCommand } from './operator-command-context';

type ClosableRecords = PendingRegistrationRecordPort & {
  close(): Promise<void>;
};

export interface RegistrationsSweepCliInput {
  readonly databaseUrl: string;
  readonly records?: ClosableRecords;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

async function openRecords(
  input: RegistrationsSweepCliInput,
): Promise<ClosableRecords> {
  if (input.records !== undefined) return input.records;
  const { createOperatorRegistrationClient } = await import(
    './operator-registration-client'
  );
  return createOperatorRegistrationClient(input.databaseUrl);
}

/**
 * Deletes registrations that were never verified within seven days, which
 * releases their email and username (ADR-0123). It prints one JSON line of
 * counts and never an address or a username. Run it once a day per deployment.
 */
export async function runRegistrationsSweepCommand(
  input: RegistrationsSweepCliInput,
): Promise<PendingRegistrationExpirySummary> {
  const emit = input.emit ?? console.log;
  const records = await openRecords(input);
  const expiry = new ExpirePendingRegistrations(records);

  const { result } = await runOperatorCommand(
    records,
    input.now,
    ({ occurredAt }) => expiry.run(occurredAt),
  );

  emit(JSON.stringify(result));
  return result;
}
