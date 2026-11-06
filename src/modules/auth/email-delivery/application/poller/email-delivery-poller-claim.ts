import type {
  ClaimEmailDeliveryRequestsInput,
  EmailDispatchStorePort,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';

export function claimEmailDeliveryBatch(
  store: EmailDispatchStorePort,
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
