import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';

export const UNUSED_EMAIL_OUTBOX: EmailOutboxPort = {
  withAdmission: async (_kind, operation) => operation(),
  reserveAuthenticationEmailRecipient: async () => true,
  queue: async () => {
    throw new Error('EmailOutbox.queue was not configured for this test');
  },
  withdraw: async () => undefined,
};
