import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import { recordEmailOutboxBackpressureRefusal } from '@/common/observability/metrics';
import type { PrismaClientHolder } from '@/modules/persistence/persistence.module';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

import type { EmailOutboxPort } from './application/email-outbox.port';
import { EmailOutbox } from './application/outbox/email-outbox';
import { EmailOutboxBackpressureGate } from './application/outbox/email-outbox-backpressure.gate';
import { PostgresEmailDispatchStore } from './infrastructure/outbox-store/postgres-email-dispatch-store';
import { PostgresEmailOutboxQueueAge } from './infrastructure/outbox-store/postgres-email-outbox-queue-age';
import { createEmailPayloadCipher } from './infrastructure/payload-cipher/email-payload-cipher';
import { PostgresEmailDeliveryRequestRepository } from './infrastructure/postgres-email-delivery-request.repository';

/** Composes the Auth adapters used by the Operator notification command. */
export function createOperatorEmailOutbox(
  prisma: PrismaClientHolder['prisma'],
  secrets: EmailOutboxRuntimeSecrets,
): EmailOutboxPort {
  const dispatchStore = new PostgresEmailDispatchStore(prisma);
  return new EmailOutbox(
    new PostgresEmailDeliveryRequestRepository(secrets),
    createEmailPayloadCipher(secrets),
    prefixedIdGenerator('edr_'),
    new EmailOutboxBackpressureGate(
      new PostgresEmailOutboxQueueAge(dispatchStore),
      recordEmailOutboxBackpressureRefusal,
    ),
  );
}
