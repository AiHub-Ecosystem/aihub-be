import type { ResendRuntimeSecrets } from '../../secrets/application/runtime-secret-provider.port';
import type {
  EmailSenderPort,
  OrganizationInviteEmailInput,
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

/**
 * Validates the optional Customer Web base URL once, at construction: blank
 * counts as unset so API-only deployments keep the token-only contract
 * byte-for-byte, and a non-http(s) value fails closed instead of producing
 * links to an unexpected scheme.
 */
function normalizeCustomerWebBaseUrl(
  value: string | undefined,
  requireHttps: boolean,
): string | undefined {
  const invalidMessage = requireHttps
    ? 'CUSTOMER_WEB_BASE_URL must be an absolute HTTPS URL without credentials, query, or fragment in production'
    : 'CUSTOMER_WEB_BASE_URL must be an absolute http(s) URL without credentials, query, or fragment';
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    if (requireHttps) {
      throw new Error('CUSTOMER_WEB_BASE_URL is required in production');
    }
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(invalidMessage);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    (requireHttps && parsed.protocol !== 'https:')
  ) {
    throw new Error(invalidMessage);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&"]/g, (character) =>
    character === '&' ? '&amp;' : '&quot;',
  );
}

export class ResendEmailSender implements EmailSenderPort {
  private readonly fetch: ResendFetch;
  private readonly secrets: ResendRuntimeSecrets;
  private readonly customerWebBaseUrl: string | undefined;

  constructor(
    secrets: ResendRuntimeSecrets,
    private readonly from: string,
    fetcher: ResendFetch = fetch,
    customerWebBaseUrl?: string,
    requireHttps = false,
  ) {
    if (from.trim().length === 0) {
      throw new Error('RESEND_FROM is required');
    }
    this.secrets = secrets;
    this.fetch = fetcher;
    this.customerWebBaseUrl = normalizeCustomerWebBaseUrl(
      customerWebBaseUrl,
      requireHttps,
    );
  }

  /**
   * Deep links are appended only when a Customer Web base URL is configured;
   * a blank value keeps emails token-only (the API-only contract). The base
   * URL itself is validated once at construction so a misconfigured
   * deployment fails at boot rather than silently losing links after the
   * cutover starts relying on them.
   */
  private deepLinkUrl(path: string, token: string): string | undefined {
    if (this.customerWebBaseUrl === undefined) return undefined;
    return `${this.customerWebBaseUrl}${path}?token=${encodeURIComponent(token)}`;
  }

  private deepLinkLine(path: string, token: string): string[] {
    const url = this.deepLinkUrl(path, token);
    if (url === undefined) return [];
    return ['', `Open AIHUB to continue: ${url}`];
  }

  async sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
    const url = this.deepLinkUrl('/verify-email', input.token);
    const expiresAt = input.expiresAt.toISOString();
    const text =
      url === undefined
        ? [
            'Use this one-time verification token to activate your AIHUB account:',
            input.token,
            '',
            `This token expires at ${expiresAt}.`,
          ].join('\n')
        : [
            'Verify your AIHUB email address using this link:',
            url,
            '',
            `This link expires at ${expiresAt}.`,
          ].join('\n');
    const html =
      url === undefined
        ? undefined
        : [
            '<!doctype html><html><body>',
            '<p>Verify your AIHUB email address:</p>',
            `<p><a href="${escapeHtmlAttribute(url)}" style="display:inline-block;padding:12px 20px;background-color:#0057b8;color:#ffffff;text-decoration:none;border-radius:4px">Verify email</a></p>`,
            `<p>This link expires at ${expiresAt}.</p>`,
            '<p>This link can be used once.</p>',
            '</body></html>',
          ].join('');

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
        text,
        ...(html === undefined ? {} : { html }),
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
          ...this.deepLinkLine('/reset-password', input.token),
        ].join('\n'),
      }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error('Resend email delivery failed');
    }
  }

  async sendOrganizationInviteEmail(
    input: OrganizationInviteEmailInput,
  ): Promise<void> {
    const response = await this.fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.secrets.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.email],
        subject: `You are invited to ${input.organizationName} on AIHUB`,
        text: [
          `You are invited to join ${input.organizationName} on AIHUB as ${input.role}.`,
          '',
          'Use this one-time invitation token to accept:',
          input.token,
          '',
          `This token expires at ${input.expiresAt.toISOString()}.`,
          ...this.deepLinkLine('/invite', input.token),
        ].join('\n'),
      }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error('Resend email delivery failed');
    }
  }
}
