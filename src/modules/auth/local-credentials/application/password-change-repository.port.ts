import type { QueueEmailDeliveryRequestInput } from '@/modules/auth/email-delivery/application/email-outbox.port';
import type { UserAccessSession } from '@/modules/auth/web-sessions/application/user-access-token.port';

export interface PasswordChangeRepositoryPort {
  changePassword(input: {
    readonly userId: string;
    readonly expectedPasswordHash: string;
    readonly passwordHash: string;
    readonly session: UserAccessSession;
    readonly now: Date;
    readonly emailDelivery: QueueEmailDeliveryRequestInput;
  }): Promise<boolean>;
}

export const PASSWORD_CHANGE_REPOSITORY = Symbol('PASSWORD_CHANGE_REPOSITORY');
