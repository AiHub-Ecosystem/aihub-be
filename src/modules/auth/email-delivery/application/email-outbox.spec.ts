import type {
  EmailDeliveryRequestWriterPort,
  EmailDeliveryTransaction,
  EmailPayloadCipherPort,
  InsertEmailDeliveryRequestInput,
} from './email-delivery-request.port';
import { EmailOutbox } from './email-outbox';

const transaction = {} as EmailDeliveryTransaction;
const now = new Date('2026-10-27T00:00:00.000Z');

function harness() {
  const inserted: InsertEmailDeliveryRequestInput[] = [];
  const cancelled: unknown[] = [];
  const contexts: unknown[] = [];
  const writer: EmailDeliveryRequestWriterPort = {
    reserveAuthenticationEmailRecipient: async () => true,
    insert: async (_transaction, input) => {
      inserted.push(input);
    },
    queuedPayloadCiphertexts: async () => [],
    cancelQueued: async (_transaction, input) => {
      cancelled.push(input);
    },
  };
  const cipher: EmailPayloadCipherPort = {
    encrypt: (plaintext, context) => {
      contexts.push(context);
      return `sealed:${plaintext}`;
    },
    decrypt: (envelope, context) => {
      contexts.push(context);
      return envelope.slice('sealed:'.length);
    },
  };
  const outbox = new EmailOutbox(writer, cipher, () => 'edr_generated', {
    admit: async () => undefined,
  });
  return { outbox, inserted, cancelled, contexts, writer };
}

describe('EmailOutbox', () => {
  it('queues a typed payload with one generated id and its authenticated context', async () => {
    const { outbox, inserted, contexts } = harness();
    const payload = {
      email: 'person@example.com',
      token: 'opaque-token',
      expiresAt: '2026-10-28T00:00:00.000Z',
    };

    await outbox.queue(transaction, {
      kind: 'verification_email',
      payload,
      createdAt: now,
    });

    expect(inserted).toEqual([
      {
        id: 'edr_generated',
        kind: 'verification_email',
        payloadCiphertext: `sealed:${JSON.stringify(payload)}`,
        createdAt: now,
      },
    ]);
    expect(contexts).toEqual([
      { id: 'edr_generated', kind: 'verification_email' },
    ]);
  });

  it('withdraws only queued payloads selected after opening them with their row context', async () => {
    const { outbox, cancelled, contexts, writer } = harness();
    const withdrawn = {
      organizationId: 'org_acme',
      userAccountId: 'usr_one',
      apiKeyIds: ['key_old'],
    };
    const current = {
      organizationId: 'org_acme',
      userAccountId: 'usr_two',
      apiKeyIds: ['key_current'],
    };
    writer.queuedPayloadCiphertexts = async () => [
      {
        id: 'edr_withdrawn',
        payloadCiphertext: `sealed:${JSON.stringify(withdrawn)}`,
      },
      {
        id: 'edr_current',
        payloadCiphertext: `sealed:${JSON.stringify(current)}`,
      },
      { id: 'edr_unreadable', payloadCiphertext: 'invalid' },
    ];

    await outbox.withdraw(transaction, {
      kind: 'api_key_near_expiry_notification',
      matches: (payload) => payload.apiKeyIds.includes('key_old'),
      reason: 'not_actionable',
      cancelledAt: now,
    });

    expect(cancelled).toEqual([
      {
        ids: ['edr_withdrawn'],
        reason: 'not_actionable',
        cancelledAt: now,
      },
    ]);
    expect(contexts).toContainEqual({
      id: 'edr_withdrawn',
      kind: 'api_key_near_expiry_notification',
    });
    expect(contexts).toContainEqual({
      id: 'edr_current',
      kind: 'api_key_near_expiry_notification',
    });
  });
});
