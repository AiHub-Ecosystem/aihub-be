import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import type { EmailDeliveryRequestWriterPort } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { EmailOutbox } from '@/modules/auth/email-delivery/application/email-outbox';
import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import { createEmailPayloadCipher } from '@/modules/auth/email-delivery/infrastructure/email-payload-cipher';
import { PostgresEmailDeliveryRequestRepository } from '@/modules/auth/email-delivery/infrastructure/postgres-email-delivery-request.repository';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

export function createDatabaseTestEmailOutbox(
  secrets: EmailOutboxRuntimeSecrets,
  requests: EmailDeliveryRequestWriterPort = new PostgresEmailDeliveryRequestRepository(
    secrets,
  ),
): EmailOutboxPort {
  return new EmailOutbox(
    requests,
    createEmailPayloadCipher(secrets),
    prefixedIdGenerator('edr_'),
    { admit: async () => undefined },
  );
}
