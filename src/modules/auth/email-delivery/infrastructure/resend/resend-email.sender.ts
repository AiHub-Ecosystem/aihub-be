import { internalError } from '@/common/errors/app-error';
import {
  EMAIL_ATTEMPT_TIMEOUT_MS,
  type EmailDispatchOptions,
  type EmailIdempotencyConflict,
  type EmailMessage,
  type EmailProviderResponse,
  EmailProviderTransportError,
  type EmailSenderPort,
} from '@/modules/auth/email-delivery/application/email-sender.port';
import type { ResendRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

interface ResendResponse {
  readonly status: number;
  readonly headers: Pick<Headers, 'get'>;
  readonly body?: { cancel(): Promise<void> } | null;
  text?(): Promise<string>;
}

/** Resend's error `name` values for a reused Idempotency-Key. */
const IDEMPOTENCY_CONFLICTS: Readonly<
  Record<string, EmailIdempotencyConflict>
> = {
  concurrent_idempotent_requests: 'concurrent',
  invalid_idempotent_request: 'payload_changed',
};

/** A Resend error document is a few hundred bytes; anything larger is not one. */
const MAX_ERROR_BODY_CHARS = 4_096;

/**
 * Undici holds the connection until a body is read or cancelled, so every
 * response is drained here instead of being left to garbage collection (#441).
 */
async function discardBody(response: ResendResponse): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is already closed or errored; nothing is held either way.
  }
}

async function readIdempotencyConflict(
  response: ResendResponse,
): Promise<EmailIdempotencyConflict | undefined> {
  if (response.text === undefined) {
    await discardBody(response);
    return undefined;
  }
  try {
    const text = await response.text();
    if (text.length > MAX_ERROR_BODY_CHARS) return undefined;
    const parsed: unknown = JSON.parse(text);
    const name =
      typeof parsed === 'object' && parsed !== null && 'name' in parsed
        ? parsed.name
        : undefined;
    return typeof name === 'string' &&
      Object.hasOwn(IDEMPOTENCY_CONFLICTS, name)
      ? IDEMPOTENCY_CONFLICTS[name]
      : undefined;
  } catch {
    return undefined;
  }
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
      throw internalError('RESEND_FROM is required');
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

    const retryAfter = response.headers.get('retry-after') ?? undefined;
    if (response.status !== 409) {
      await discardBody(response);
      return { status: response.status, retryAfter };
    }
    const idempotencyConflict = await readIdempotencyConflict(response);
    return {
      status: response.status,
      retryAfter,
      ...(idempotencyConflict === undefined ? {} : { idempotencyConflict }),
    };
  }
}
