import type { EmailMessage } from './email-sender.port';

export interface VerificationEmailInput {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface PasswordResetEmailInput {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface OrganizationInviteEmailInput {
  readonly email: string;
  readonly organizationName: string;
  readonly role: 'owner' | 'admin' | 'member';
  readonly token: string;
  readonly expiresAt: Date;
}

export interface MfaSecurityNotificationInput {
  readonly email: string;
  readonly action: 'enabled' | 'removed';
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

/** Validates and normalizes the optional Customer Web URL at application startup. */
export function normalizeCustomerWebBaseUrl(
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

function deepLink(
  baseUrl: string | undefined,
  path: string,
  token: string,
): string | undefined {
  if (baseUrl === undefined) return undefined;
  return `${baseUrl}${path}?token=${encodeURIComponent(token)}`;
}

interface LinkedEmailHtmlInput {
  readonly title: string;
  readonly introduction: string;
  readonly buttonLabel: string;
  readonly url: string;
  readonly expiryLabel: string;
  readonly expiresAt: string;
  readonly additionalCopy?: readonly string[];
}

function linkedEmailHtml(input: LinkedEmailHtmlInput): string {
  const paragraphs = (input.additionalCopy ?? [])
    .map(
      (copy) =>
        `<p style="margin:0 0 12px;color:#475467;font-size:14px;line-height:1.6">${escapeHtml(copy)}</p>`,
    )
    .join('');

  return [
    '<!doctype html><html lang="vi"><body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#1d2838">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9"><tr><td align="center" style="padding:32px 16px">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border:1px solid #e4e7ec;border-radius:16px;background-color:#ffffff"><tr><td style="padding:36px">',
    '<p style="margin:0 0 12px;color:#3a64fa;font-size:12px;font-weight:700;letter-spacing:2px">AIHUB CONSOLE</p>',
    `<h1 style="margin:0 0 20px;color:#1d2838;font-size:28px;line-height:1.25">${escapeHtml(input.title)}</h1>`,
    '<p style="margin:0 0 12px;font-size:16px;line-height:1.6">Chào bạn,</p>',
    `<p style="margin:0 0 24px;color:#475467;font-size:16px;line-height:1.6">${escapeHtml(input.introduction)}</p>`,
    `<p style="margin:0 0 24px"><a href="${escapeHtml(input.url)}" style="display:inline-block;padding:14px 24px;border-radius:8px;background-color:#3a64fa;color:#ffffff;font-size:16px;font-weight:700;line-height:1.4;text-align:center;text-decoration:none">${escapeHtml(input.buttonLabel)}</a></p>`,
    `<p style="margin:0 0 16px;color:#475467;font-size:14px;line-height:1.6">${escapeHtml(input.expiryLabel)} <strong style="color:#1d2838">${escapeHtml(input.expiresAt)}</strong> (giờ Việt Nam).</p>`,
    paragraphs,
    '<hr style="height:1px;margin:28px 0 16px;border:0;background-color:#e4e7ec">',
    '<p style="margin:0;color:#667084;font-size:12px">AIHUB Console</p>',
    '</td></tr></table></td></tr></table>',
    '</body></html>',
  ].join('');
}

export function composeVerificationEmail(
  input: VerificationEmailInput,
  customerWebBaseUrl?: string,
): EmailMessage {
  const url = deepLink(customerWebBaseUrl, '/verify-email', input.token);
  const expiresAt = formatVietnameseDateTime(input.expiresAt);
  const repeatVerificationCopy =
    'Liên kết này chỉ dùng để kích hoạt tài khoản một lần. Nếu email đã được xác minh, mở lại liên kết vẫn sẽ hiển thị xác nhận thành công.';
  const message: EmailMessage = {
    recipient: input.email,
    subject: 'Xác minh địa chỉ email AIHUB',
    text:
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
          ].join('\n'),
    ...(url === undefined
      ? {}
      : {
          html: linkedEmailHtml({
            title: 'Xác minh email',
            introduction:
              'Cảm ơn bạn đã đăng ký AIHUB. Nhấn nút bên dưới để xác minh địa chỉ email và kích hoạt tài khoản.',
            buttonLabel: 'Xác nhận email',
            url,
            expiryLabel: 'Liên kết có hiệu lực đến',
            expiresAt,
            additionalCopy: [
              repeatVerificationCopy,
              'Nếu bạn không tạo tài khoản AIHUB, hãy bỏ qua email này.',
            ],
          }),
        }),
  };
  return message;
}

export function composePasswordResetEmail(
  input: PasswordResetEmailInput,
  customerWebBaseUrl?: string,
): EmailMessage {
  const url = deepLink(customerWebBaseUrl, '/reset-password', input.token);
  const expiresAt = formatVietnameseDateTime(input.expiresAt);
  if (url === undefined) {
    return {
      recipient: input.email,
      subject: 'Đặt lại mật khẩu AIHUB',
      text: [
        'Dùng mã đặt lại mật khẩu một lần này để thay đổi mật khẩu AIHUB:',
        input.token,
        '',
        `Mã đặt lại mật khẩu hết hạn ${expiresAt} (giờ Việt Nam).`,
      ].join('\n'),
    };
  }
  return {
    recipient: input.email,
    subject: 'Đặt lại mật khẩu AIHUB',
    text: [
      'Chào bạn,',
      '',
      'Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu cho tài khoản AIHUB của bạn. Nhấn nút bên dưới để tạo mật khẩu mới:',
      '',
      url,
      '',
      `Liên kết có hiệu lực đến ${expiresAt} (giờ Việt Nam).`,
      '',
      'Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.',
    ].join('\n'),
    html: linkedEmailHtml({
      title: 'Đặt lại mật khẩu',
      introduction:
        'Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu cho tài khoản AIHUB của bạn. Nhấn nút bên dưới để tạo mật khẩu mới.',
      buttonLabel: 'Đặt lại mật khẩu',
      url,
      expiryLabel: 'Liên kết có hiệu lực đến',
      expiresAt,
      additionalCopy: [
        'Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.',
      ],
    }),
  };
}

const INVITATION_ROLE_LABELS: Record<
  OrganizationInviteEmailInput['role'],
  string
> = {
  owner: 'chủ sở hữu',
  admin: 'quản trị viên',
  member: 'thành viên',
};

export function composeOrganizationInviteEmail(
  input: OrganizationInviteEmailInput,
  customerWebBaseUrl?: string,
): EmailMessage {
  const url = deepLink(customerWebBaseUrl, '/invite', input.token);
  const expiresAt = formatVietnameseDateTime(input.expiresAt);
  const role = INVITATION_ROLE_LABELS[input.role];
  const invitationSentence = `Bạn được mời tham gia tổ chức ${input.organizationName} trên AIHUB với vai trò ${role}.`;
  if (url === undefined) {
    return {
      recipient: input.email,
      subject: `Lời mời tham gia ${input.organizationName} trên AIHUB`,
      text: [
        invitationSentence,
        '',
        'Dùng mã mời một lần này để chấp nhận lời mời:',
        input.token,
        '',
        `Mã mời hết hạn ${expiresAt} (giờ Việt Nam).`,
      ].join('\n'),
    };
  }
  return {
    recipient: input.email,
    subject: `Lời mời tham gia ${input.organizationName} trên AIHUB`,
    text: [
      'Chào bạn,',
      '',
      `${invitationSentence} Nhấn vào liên kết bên dưới để chấp nhận lời mời:`,
      '',
      url,
      '',
      `Lời mời có hiệu lực đến ${expiresAt} (giờ Việt Nam).`,
      '',
      'Nếu bạn không mong đợi lời mời này, hãy bỏ qua email.',
    ].join('\n'),
    html: linkedEmailHtml({
      title: 'Lời mời tham gia tổ chức',
      introduction: `${invitationSentence} Nhấn nút bên dưới để chấp nhận lời mời.`,
      buttonLabel: 'Chấp nhận lời mời',
      url,
      expiryLabel: 'Lời mời có hiệu lực đến',
      expiresAt,
      additionalCopy: ['Nếu bạn không mong đợi lời mời này, hãy bỏ qua email.'],
    }),
  };
}

export function composeMfaSecurityNotification(
  input: MfaSecurityNotificationInput,
): EmailMessage {
  const enabled = input.action === 'enabled';
  return {
    recipient: input.email,
    subject: enabled
      ? 'AIHUB two-factor authentication enabled'
      : 'AIHUB two-factor authentication removed',
    text: enabled
      ? 'A TOTP second factor was enabled on your AIHUB account. If you did not make this change, contact AIHUB support immediately.'
      : 'The TOTP second factor was removed from your AIHUB account and all refresh and web sessions were ended. If you did not make this change, contact AIHUB support immediately.',
  };
}
