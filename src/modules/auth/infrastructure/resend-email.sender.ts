import type { ResendRuntimeSecrets } from '../../secrets/application/runtime-secret-provider.port';
import type {
  EmailSenderPort,
  PasswordResetEmailInput,
  VerificationEmailInput,
} from '../application/email-sender.port';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DELIVERY_TIMEOUT_MS = 5_000;

interface ResendResponse {
  readonly ok: boolean;
}

export type ResendFetch = (
  input: string,
  init?: RequestInit,
) => Promise<ResendResponse>;

export class ResendEmailSender implements EmailSenderPort {
  private readonly fetch: ResendFetch;
  private readonly secrets: ResendRuntimeSecrets;

  constructor(
    secrets: ResendRuntimeSecrets,
    private readonly from: string,
    fetcher: ResendFetch = fetch,
  ) {
    if (from.trim().length === 0) {
      throw new Error('RESEND_FROM is required');
    }
    this.secrets = secrets;
    this.fetch = fetcher;
  }

  async sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
    const response = await this.fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.secrets.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.email],
        subject: 'Verify your AIHUB email address',
        text: [
          'Use this one-time verification token to activate your AIHUB account:',
          input.token,
          '',
          `This token expires at ${input.expiresAt.toISOString()}.`,
        ].join('\n'),
      }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error('Resend email delivery failed');
    }
  }

  async sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
    const response = await this.fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.secrets.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.email],
        subject: 'Reset your AIHUB password',
        text: [
          'Use this one-time password reset token to change your AIHUB password:',
          input.token,
          '',
          `This token expires at ${input.expiresAt.toISOString()}.`,
        ].join('\n'),
      }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error('Resend email delivery failed');
    }
  }
}
