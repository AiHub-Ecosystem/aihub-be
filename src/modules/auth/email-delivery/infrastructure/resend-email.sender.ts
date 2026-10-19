import type {
  EmailDispatchOptions,
  EmailMessage,
  EmailSenderPort,
} from '@/modules/auth/email-delivery/application/email-sender.port';
import { EMAIL_ATTEMPT_TIMEOUT_MS } from '@/modules/auth/email-delivery/application/email-sender.port';
import type { ResendRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

interface ResendResponse {
  readonly ok: boolean;
}

export type ResendFetch = (
  input: string,
  init?: RequestInit,
) => Promise<ResendResponse>;

export class ResendEmailSender implements EmailSenderPort {
  constructor(
    private readonly secrets: ResendRuntimeSecrets,
    private readonly from: string,
    private readonly fetcher: ResendFetch = fetch,
  ) {
    if (from.trim().length === 0) {
      throw new Error('RESEND_FROM is required');
    }
  }

  private headers(
    options: EmailDispatchOptions | undefined,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.secrets.apiKey}`,
      'content-type': 'application/json',
    };
    if (options?.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    return headers;
  }

  async send(
    message: EmailMessage,
    options?: EmailDispatchOptions,
  ): Promise<void> {
    const response = await this.fetcher(RESEND_ENDPOINT, {
      method: 'POST',
      headers: this.headers(options),
      body: JSON.stringify({
        from: this.from,
        to: [message.recipient],
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
      }),
      signal: AbortSignal.timeout(EMAIL_ATTEMPT_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error('Resend email delivery failed');
    }
  }
}
