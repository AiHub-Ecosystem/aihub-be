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
  requireCustomerWebUrl: boolean,
): string | undefined {
  const invalidMessage = requireHttps
    ? 'CUSTOMER_WEB_BASE_URL must be an absolute HTTPS URL without credentials, query, or fragment in production'
    : 'CUSTOMER_WEB_BASE_URL must be an absolute http(s) URL without credentials, query, or fragment';
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    if (requireCustomerWebUrl) {
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function formatVietnameseDateTime(value: Date): string {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(value);
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
    requireCustomerWebUrl = requireHttps,
  ) {
    if (from.trim().length === 0) {
      throw new Error('RESEND_FROM is required');
    }
    this.secrets = secrets;
    this.fetch = fetcher;
    this.customerWebBaseUrl = normalizeCustomerWebBaseUrl(
      customerWebBaseUrl,
      requireHttps,
      requireCustomerWebUrl,
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
    const expiresAt = formatVietnameseDateTime(input.expiresAt);
    const repeatVerificationCopy =
      'Liên kết này chỉ dùng để kích hoạt tài khoản một lần. Nếu email đã được xác minh, mở lại liên kết vẫn sẽ hiển thị xác nhận thành công.';
    const text =
      url === undefined
        ? [
            'Dùng mã xác minh một lần này để kích hoạt tài khoản AIHUB:',
            input.token,
            '',
            `Mã xác minh hết hạn ${expiresAt} (giờ Việt Nam).`,
          ].join('\n')
        : [
            'Chào bạn,',
            '',
            'Cảm ơn bạn đã đăng ký AIHUB. Nhấn vào liên kết bên dưới để xác minh địa chỉ email và kích hoạt tài khoản:',
            '',
            url,
            '',
            `Liên kết có hiệu lực đến ${expiresAt} (giờ Việt Nam).`,
            '',
            repeatVerificationCopy,
            '',
            'Nếu bạn không tạo tài khoản AIHUB, hãy bỏ qua email này.',
          ].join('\n');
    const html =
      url === undefined
        ? undefined
        : [
            '<!doctype html><html lang="vi"><body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#1d2838">',
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9"><tr><td align="center" style="padding:32px 16px">',
            '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border:1px solid #e4e7ec;border-radius:16px;background-color:#ffffff"><tr><td style="padding:36px">',
            '<p style="margin:0 0 12px;color:#3a64fa;font-size:12px;font-weight:700;letter-spacing:2px">AIHUB CONSOLE</p>',
            '<h1 style="margin:0 0 20px;color:#1d2838;font-size:28px;line-height:1.25">Xác minh email</h1>',
            '<p style="margin:0 0 12px;font-size:16px;line-height:1.6">Chào bạn,</p>',
            '<p style="margin:0 0 24px;color:#475467;font-size:16px;line-height:1.6">Cảm ơn bạn đã đăng ký AIHUB. Nhấn nút bên dưới để xác minh địa chỉ email và kích hoạt tài khoản.</p>',
            `<p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 24px;border-radius:8px;background-color:#3a64fa;color:#ffffff;font-size:16px;font-weight:700;line-height:1.4;text-align:center;text-decoration:none">Xác nhận email</a></p>`,
            `<p style="margin:0 0 16px;color:#475467;font-size:14px;line-height:1.6">Liên kết có hiệu lực đến <strong style="color:#1d2838">${escapeHtml(expiresAt)}</strong> (giờ Việt Nam).</p>`,
            `<p style="margin:0 0 12px;color:#475467;font-size:14px;line-height:1.6">${escapeHtml(repeatVerificationCopy)}</p>`,
            '<p style="margin:0;color:#475467;font-size:14px;line-height:1.6">Nếu bạn không tạo tài khoản AIHUB, hãy bỏ qua email này.</p>',
            '<hr style="height:1px;margin:28px 0 16px;border:0;background-color:#e4e7ec">',
            '<p style="margin:0;color:#667084;font-size:12px">AIHUB Console</p>',
            '</td></tr></table></td></tr></table>',
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
        subject: 'Xác minh địa chỉ email AIHUB',
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
