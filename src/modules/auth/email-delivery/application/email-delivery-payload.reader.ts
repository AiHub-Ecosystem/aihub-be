import type {
  EmailDeliveryRequestRecord,
  EmailPayloadCipherPort,
} from './email-delivery-request.port';
import { EnvelopeCipherError } from './email-delivery-request.port';
import { EMAIL_KIND_HANDLERS } from './email-kind-handler.registry';
import type { ValidatedEmailDelivery } from './email-kind-handler.registry';

/**
 * What a claimed request's payload turned out to be.
 *
 * `undefined` is a payload that is absent. `'unreadable'` is one that will never
 * open: an envelope that fails authentication (tampered, moved to another row or
 * kind, or sealed under a key id that now holds other material), or plaintext
 * that is not the shape its kind needs. An unknown key version is neither, and
 * is rethrown so the row can go back with its ciphertext instead of being failed
 * out from under an instance that holds the key.
 */
export function readEmailPayload(
  cipher: EmailPayloadCipherPort,
  request: EmailDeliveryRequestRecord,
): ValidatedEmailDelivery | 'unreadable' | undefined {
  const ciphertext = request.payloadCiphertext;
  if (ciphertext === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      cipher.decrypt(ciphertext, { id: request.id, kind: request.kind }),
    );
  } catch (error) {
    if (error instanceof EnvelopeCipherError && error.kind === 'unknown-key') {
      throw error;
    }
    return 'unreadable';
  }
  const handler = EMAIL_KIND_HANDLERS[request.kind];
  return handler !== undefined && handler.isPayload(parsed)
    ? { handler, payload: parsed }
    : 'unreadable';
}
