import {
  API_KEY_NEAR_EXPIRY_WINDOW_MS,
  type ApiKeyNearExpiryNotificationInput,
} from './email-delivery-request.port';
import type { EmailMessage } from './email-sender.port';
import { AUTH_TRANSACTIONAL_EMAIL_TEMPLATE } from './templates/transactional-email.template.generated';

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

const DAY_MS = 24 * 60 * 60 * 1000;

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
  readonly notice?: string;
  readonly closing?: string;
}

function linkedEmailHtml(input: LinkedEmailHtmlInput): string {
  const values = {
    title: input.title,
    introduction: input.introduction,
    buttonLabel: input.buttonLabel,
    url: input.url,
    expiryLabel: input.expiryLabel,
    expiresAt: input.expiresAt,
    notice: input.notice ?? '',
    closing: input.closing ?? '',
  };
  return AUTH_TRANSACTIONAL_EMAIL_TEMPLATE.replace(
    /\{\{(\w+)\}\}/g,
    (_placeholder, name: string) => {
      const value = values[name as keyof typeof values];
      if (value === undefined) {
        throw new Error(`Unknown transactional email placeholder: ${name}`);
      }
      return escapeHtml(value);
    },
  );
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
            notice: repeatVerificationCopy,
            closing: 'Nếu bạn không tạo tài khoản AIHUB, hãy bỏ qua email này.',
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
      notice: 'Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.',
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
      notice: 'Nếu bạn không mong đợi lời mời này, hãy bỏ qua email.',
    }),
  };
}

/**
 * Rotation keeps a key's expiry (#986), so the only remedy the notice can name
 * is a replacement key followed by revoking the old one (ADR-0120).
 */
export function composeApiKeyNearExpiryNotification(
  input: ApiKeyNearExpiryNotificationInput,
  customerWebBaseUrl?: string,
): EmailMessage {
  const url =
    customerWebBaseUrl === undefined
      ? undefined
      : `${customerWebBaseUrl}/console/orgs/${encodeURIComponent(input.organizationId)}/api-keys`;
  const keyLines = input.apiKeys.map(
    (key) =>
      `${key.name} (${key.id}): hết hạn ${formatVietnameseDateTime(key.expiresAt)} (giờ Việt Nam)`,
  );
  const earliest = new Date(
    Math.min(...input.apiKeys.map((key) => key.expiresAt.getTime())),
  );
  const subject = `API key của ${input.organizationName} trên AIHUB sắp hết hạn`;
  const introduction = `Các API key sau của tổ chức ${input.organizationName} sẽ hết hạn trong vòng ${API_KEY_NEAR_EXPIRY_WINDOW_MS / DAY_MS} ngày và sau đó không thể xác thực request.`;
  const remedy =
    'Hãy tạo API key mới, chuyển ứng dụng sang key mới, rồi thu hồi key cũ. Xoay vòng (rotate) không gia hạn key.';
  const text = [
    'Chào bạn,',
    '',
    introduction,
    '',
    ...keyLines.map((line) => `- ${line}`),
    '',
    remedy,
    ...(url === undefined ? [] : ['', url]),
  ].join('\n');
  if (url === undefined) return { recipient: input.email, subject, text };
  return {
    recipient: input.email,
    subject,
    text,
    html: linkedEmailHtml({
      title: 'API key sắp hết hạn',
      introduction: `${introduction} ${keyLines.join('; ')}.`,
      buttonLabel: 'Quản lý API key',
      url,
      expiryLabel: 'Key đầu tiên hết hạn',
      expiresAt: `${formatVietnameseDateTime(earliest)} (giờ Việt Nam)`,
      notice: remedy,
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
