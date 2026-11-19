import type { ClaimEmailDeliveryRequestsInput } from '@/modules/auth/email-delivery/application/email-delivery-request.types';
import type { EmailDispatchClaimPort } from '@/modules/auth/email-delivery/application/email-dispatch-store.port';

export function claimEmailDeliveryBatch(
  store: EmailDispatchClaimPort,
  input: ClaimEmailDeliveryRequestsInput & { readonly batchSize: number },
  claimSuppressed: boolean,
) {
  if (claimSuppressed) return Promise.resolve([]);
  const { batchSize, ...claim } = input;
  return store.claim({
    ...claim,
    limit: Math.min(input.ids?.length ?? batchSize, batchSize),
  });
}
