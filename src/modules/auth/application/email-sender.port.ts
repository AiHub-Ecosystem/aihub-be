export interface VerificationEmailInput {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface EmailSenderPort {
  sendVerificationEmail(input: VerificationEmailInput): Promise<void>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
