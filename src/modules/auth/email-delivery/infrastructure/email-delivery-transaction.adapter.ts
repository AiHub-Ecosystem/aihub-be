import type { EmailDeliveryTransaction } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { emailDeliveryTransactionBrand } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type { AuthTransactionClient } from '@/modules/auth/shared/infrastructure/auth-prisma';

export class EmailDeliveryTransactionAdapter
  implements EmailDeliveryTransaction
{
  readonly [emailDeliveryTransactionBrand] = undefined as never;

  constructor(public readonly client: AuthTransactionClient) {}
}
