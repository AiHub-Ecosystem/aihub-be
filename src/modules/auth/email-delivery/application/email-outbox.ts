import type { IdMinter } from '@/common/ids/prefixed-id';
import type {
  EmailDeliveryCancelReason,
  EmailDeliveryKind,
  EmailDeliveryRequestWriterPort,
  EmailDeliveryTransaction,
  EmailPayloadCipherPort,
} from './email-delivery-request.port';
import { EMAIL_KIND_POLICIES } from './email-kind-handler.registry';
import type { AdmitEmailRequestPort } from './email-outbox-backpressure.port';
import type {
  EmailDeliveryPayloadByKind,
  EmailOutboxPort,
  QueueEmailDeliveryRequestInput,
} from './email-outbox.port';

export class EmailOutbox implements EmailOutboxPort {
  constructor(
    private readonly requests: EmailDeliveryRequestWriterPort,
    private readonly cipher: EmailPayloadCipherPort,
    private readonly newId: IdMinter,
    private readonly backpressure: AdmitEmailRequestPort,
  ) {}

  async withAdmission<T>(
    kind: Parameters<AdmitEmailRequestPort['admit']>[0],
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.backpressure.admit(kind);
    return operation();
  }

  reserveAuthenticationEmailRecipient(
    transaction: EmailDeliveryTransaction,
    input: { readonly email: string; readonly now: Date },
  ): Promise<boolean> {
    return this.requests.reserveAuthenticationEmailRecipient(
      transaction,
      input,
    );
  }

  async queue(
    transaction: EmailDeliveryTransaction,
    input: QueueEmailDeliveryRequestInput,
  ): Promise<void> {
    const id = this.newId(input.createdAt);
    const payloadCiphertext = this.cipher.encrypt(
      JSON.stringify(input.payload),
      { id, kind: input.kind },
    );
    const record = { id, payloadCiphertext, createdAt: input.createdAt };
    if (input.kind === 'organization_invite_email') {
      await this.requests.insert(transaction, {
        ...record,
        kind: input.kind,
        organizationId: input.organizationId,
        inviterId: input.inviterId,
      });
      return;
    }
    await this.requests.insert(transaction, { ...record, kind: input.kind });
  }

  async withdraw<K extends EmailDeliveryKind>(
    transaction: EmailDeliveryTransaction,
    input: {
      readonly kind: K;
      readonly matches: (payload: EmailDeliveryPayloadByKind[K]) => boolean;
      readonly reason: EmailDeliveryCancelReason;
      readonly cancelledAt: Date;
    },
  ): Promise<void> {
    const queued = await this.requests.queuedPayloadCiphertexts(transaction, {
      kind: input.kind,
    });
    const handler = EMAIL_KIND_POLICIES[input.kind].handler;
    const ids: string[] = [];
    for (const request of queued) {
      let payload: unknown;
      try {
        payload = JSON.parse(
          this.cipher.decrypt(request.payloadCiphertext, {
            id: request.id,
            kind: input.kind,
          }),
        );
      } catch {
        continue;
      }
      if (
        handler.isPayload(payload) &&
        input.matches(payload as EmailDeliveryPayloadByKind[K])
      ) {
        ids.push(request.id);
      }
    }
    await this.requests.cancelQueued(transaction, {
      ids,
      reason: input.reason,
      cancelledAt: input.cancelledAt,
    });
  }
}
