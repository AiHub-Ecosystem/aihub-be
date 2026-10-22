import type {
  EmailDispatchOptions,
  EmailMessage,
  EmailProviderResponse,
  EmailSenderPort,
} from '@/modules/auth/email-delivery/application/email-sender.port';
import {
  EMAIL_ATTEMPT_TIMEOUT_MS,
  EmailProviderTransportError,
} from '@/modules/auth/email-delivery/application/email-sender.port';
import type { ResendRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

interface ResendResponse {
  readonly status: number;
  readonly headers: Pick<Headers, 'get'>;
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
  ): Promise<EmailProviderResponse> {
    const request: RequestInit = {
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
    };
    let response: ResendResponse;
    try {
      response = await this.fetcher(RESEND_ENDPOINT, request);
    } catch {
      throw new EmailProviderTransportError();
    }

    return {
      status: response.status,
      retryAfter: response.headers.get('retry-after') ?? undefined,
    };
  }
}
