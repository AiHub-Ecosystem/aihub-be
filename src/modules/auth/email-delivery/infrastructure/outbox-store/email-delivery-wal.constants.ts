export const EMAIL_DELIVERY_WAL_MESSAGE_PREFIX = 'aihub_email_delivery';
export const EMAIL_DELIVERY_WAL_PUBLICATION = 'aihub_email_delivery';

export function emailDeliveryWalSlot(databaseScope: string): string {
  return databaseScope === 'sandbox'
    ? 'aihub_sandbox_email_delivery'
    : 'aihub_email_delivery';
}
