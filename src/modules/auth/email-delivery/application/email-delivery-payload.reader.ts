import type {
  EmailDeliveryRequestRecord,
  EmailPayloadCipherPort,
} from './email-delivery-request.port';
import { EnvelopeCipherError } from './email-delivery-request.port';
import { EMAIL_KIND_POLICIES } from './email-kind-handler.registry';
import type { ValidatedEmailDelivery } from './email-kind-handler.registry';

/**
 * What a claimed request's payload turned out to be.
 *
 * `undefined` is a payload that is absent. `'unreadable'` is one that will never
 * open: an envelope that fails authentication (tampered, moved to another row or
 * kind, or sealed under a key id that now holds other material), or plaintext
 * that is not the shape its kind needs. `'key_unavailable'` distinguishes a
 * valid envelope whose key version was removed from the instance's keyring.
 * `'unrecognised'` is a payload that is valid except for a value only a newer
 * release knows; it can open once that release runs, so it is not a failure.
 */
export function readEmailPayload(
  cipher: EmailPayloadCipherPort,
  request: EmailDeliveryRequestRecord,
):
  | ValidatedEmailDelivery
  | 'key_unavailable'
  | 'unreadable'
  | 'unrecognised'
  | undefined {
  const ciphertext = request.payloadCiphertext;
  if (ciphertext === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      cipher.decrypt(ciphertext, { id: request.id, kind: request.kind }),
    );
  } catch (error) {
    if (error instanceof EnvelopeCipherError && error.kind === 'unknown-key') {
      return 'key_unavailable';
    }
    return 'unreadable';
  }
  const handler = EMAIL_KIND_POLICIES[request.kind].handler;
  if (!handler.isPayload(parsed)) {
    return handler.hasUnrecognisedValue(parsed) ? 'unrecognised' : 'unreadable';
  }
  return { handler, payload: parsed };
}
