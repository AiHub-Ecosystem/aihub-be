import { emailDeliveryWalSlot } from './email-delivery-wal.constants';

describe('emailDeliveryWalSlot', () => {
  it('uses different cluster-wide slot names for Production and Sandbox', () => {
    expect(emailDeliveryWalSlot('production')).toBe('aihub_email_delivery');
    expect(emailDeliveryWalSlot('sandbox')).toBe(
      'aihub_sandbox_email_delivery',
    );
  });
});
