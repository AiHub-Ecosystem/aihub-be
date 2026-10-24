import {
  composeApiKeyNearExpiryNotification,
  composeMfaSecurityNotification,
  composeOrganizationInviteEmail,
  composePasswordResetEmail,
  composeVerificationEmail,
  normalizeCustomerWebBaseUrl,
} from './email-message.composer';
import { AUTH_TRANSACTIONAL_EMAIL_TEMPLATE } from './templates/transactional-email.template.generated';

describe('Auth email message composition', () => {
  const expiresAt = new Date('2026-09-20T00:00:00.000Z');
  const customerWebBaseUrl = 'https://customer.example.com';

  describe('API key near-expiry notice', () => {
    const input = {
      email: 'owner@example.com',
      organizationId: 'org_123',
      organizationName: 'Resonance',
      apiKeys: [
        { id: 'key_a', name: 'Production server', expiresAt },
        {
          id: 'key_b',
          name: 'Batch <grader>',
          expiresAt: new Date('2026-09-25T00:00:00.000Z'),
        },
      ],
    };

    it('names every listed key by name, id, and Vietnam-time expiry', () => {
      const message = composeApiKeyNearExpiryNotification(
        input,
        customerWebBaseUrl,
      );

      expect(message).toMatchObject({
        recipient: 'owner@example.com',
        subject: 'API key của Resonance trên AIHUB sắp hết hạn',
      });
      expect(message.text).toContain(
        'Production server (key_a): hết hạn lúc 07:00 20 tháng 9, 2026 (giờ Việt Nam)',
      );
      expect(message.text).toContain('Batch <grader> (key_b)');
      expect(message.text).toContain(
        'https://customer.example.com/console/orgs/org_123/api-keys',
      );
      expect(message.text).toContain('tạo API key mới');
      expect(message.text).toContain('trong vòng 14 ngày');
      expect(message.html).toContain(
        'href="https://customer.example.com/console/orgs/org_123/api-keys"',
      );
      expect(message.html).toContain('Batch &lt;grader&gt;');
      // The template renders the timezone suffix itself, so the value the
      // composer passes must stay bare or the expiry row shows it twice
      // (#1140).
      expect(message.html).toContain(
        'Key đầu tiên hết hạn <strong style="color:#1d2838">lúc 07:00 20 tháng 9, 2026</strong> (giờ Việt Nam).',
      );
      expect(message.html).not.toContain('(giờ Việt Nam) (giờ Việt Nam)');
    });

    it('stays text-only without a Customer Web URL', () => {
      const message = composeApiKeyNearExpiryNotification(input);

      expect(message.text).toContain('Production server (key_a)');
      expect(message.text).not.toContain('https://');
      expect(message.html).toBeUndefined();
    });
  });

  it('keeps the compiled MJML URL placeholder in the button href', () => {
    expect(AUTH_TRANSACTIONAL_EMAIL_TEMPLATE).toContain('href="{{url}}"');
  });

  it('composes the existing Vietnamese verification message as a deep link', () => {
    const message = composeVerificationEmail(
      { email: 'person@example.com', token: 'opaque-token', expiresAt },
      customerWebBaseUrl,
    );

    expect(message).toMatchObject({
      recipient: 'person@example.com',
      subject: 'Xác minh địa chỉ email AIHUB',
    });
    expect(message.text).toContain(
      'https://customer.example.com/verify-email?token=opaque-token',
    );
    expect(message.text).toContain('lúc 07:00 20 tháng 9, 2026 (giờ Việt Nam)');
    expect(message.text).toContain(
      'Liên kết này chỉ dùng để kích hoạt tài khoản một lần.',
    );
    expect(message.html).toContain('<html lang="vi"');
    expect(message.html).toContain('Xác nhận email');
    expect(message.html).toContain(
      'href="https://customer.example.com/verify-email?token=opaque-token"',
    );
    expect(message.html).toContain('07:00 20 tháng 9, 2026');
  });

  it('keeps verification token-only when Customer Web is unset', () => {
    const message = composeVerificationEmail({
      email: 'person@example.com',
      token: 'verify-token',
      expiresAt,
    });

    expect(message.text).toContain('verify-token');
    expect(message.text).toContain('Mã xác minh hết hạn');
    expect(message.text).toContain('(giờ Việt Nam)');
    expect(message.html).toBeUndefined();
  });

  it('escapes the configured Customer Web path in HTML while keeping its text link intact', () => {
    const baseUrl = normalizeCustomerWebBaseUrl(
      'https://customer.example.com/web&more/',
      false,
      false,
    );
    const message = composeVerificationEmail(
      {
        email: 'person@example.com',
        token: 'a+b/c=d',
        expiresAt,
      },
      baseUrl,
    );

    expect(message.text).toContain(
      'https://customer.example.com/web&more/verify-email?token=a%2Bb%2Fc%3Dd',
    );
    expect(message.html).toContain(
      'href="https://customer.example.com/web&amp;more/verify-email?token=a%2Bb%2Fc%3Dd"',
    );
  });

  it('composes password reset in Vietnamese with only an encoded link when configured', () => {
    const rawToken = 'a+b/c=d';
    const message = composePasswordResetEmail(
      { email: 'person@example.com', token: rawToken, expiresAt },
      customerWebBaseUrl,
    );

    expect(message.subject).toBe('Đặt lại mật khẩu AIHUB');
    expect(message.text).toContain(
      'https://customer.example.com/reset-password?token=a%2Bb%2Fc%3Dd',
    );
    expect(message.text).toContain('lúc 07:00 20 tháng 9, 2026 (giờ Việt Nam)');
    expect(message.text).not.toContain(rawToken);
    expect(message.html).toContain('Đặt lại mật khẩu');
    expect(message.html).toContain(
      'href="https://customer.example.com/reset-password?token=a%2Bb%2Fc%3Dd"',
    );
    expect(message.html).toContain('07:00 20 tháng 9, 2026');
  });

  it('keeps password reset token-only when Customer Web is unset', () => {
    const message = composePasswordResetEmail({
      email: 'person@example.com',
      token: 'reset-token',
      expiresAt,
    });

    expect(message.text).toContain('reset-token');
    expect(message.text).toContain('Mã đặt lại mật khẩu hết hạn');
    expect(message.text).toContain('(giờ Việt Nam)');
    expect(message.text).not.toContain('http');
    expect(message.html).toBeUndefined();
  });

  it.each([
    ['owner', 'chủ sở hữu'],
    ['admin', 'quản trị viên'],
    ['member', 'thành viên'],
  ] as const)(
    'uses the Vietnamese display label for the %s invitation role',
    (role, label) => {
      const message = composeOrganizationInviteEmail(
        {
          email: 'invitee@example.com',
          organizationName: 'Acme',
          role,
          token: 'a+b/c=d',
          expiresAt,
        },
        customerWebBaseUrl,
      );

      expect(message.recipient).toBe('invitee@example.com');
      expect(message.subject).toBe('Lời mời tham gia một tổ chức trên AIHUB');
      expect(message.text).toContain(`với vai trò ${label}`);
      expect(message.text).toContain(
        'https://customer.example.com/invite?token=a%2Bb%2Fc%3Dd',
      );
      expect(message.text).not.toContain('a+b/c=d');
      expect(message.text).toContain(
        'lúc 07:00 20 tháng 9, 2026 (giờ Việt Nam)',
      );
      expect(message.html).toContain(label);
      expect(message.html).toContain(
        'href="https://customer.example.com/invite?token=a%2Bb%2Fc%3Dd"',
      );
      expect(message.html).toContain('07:00 20 tháng 9, 2026');
    },
  );

  it('opens the invitation with the inviter and the quoted Organization name', () => {
    const message = composeOrganizationInviteEmail(
      {
        email: 'invitee@example.com',
        organizationName: 'Acme',
        role: 'member',
        token: 'invite-token',
        expiresAt,
        inviterUsername: 'alice',
      },
      customerWebBaseUrl,
    );

    // The subject is AIHUB's own wording: the name never reaches it.
    expect(message.subject).toBe('Lời mời tham gia một tổ chức trên AIHUB');
    expect(message.subject).not.toContain('Acme');
    expect(message.text).toContain(
      'Chào bạn,\n\nalice mời bạn tham gia tổ chức “Acme”',
    );
    expect(message.text).toContain(
      'alice mời bạn tham gia tổ chức “Acme” trên AIHUB với vai trò thành viên.',
    );
    expect(message.html).toContain(
      'alice mời bạn tham gia tổ chức “Acme” trên AIHUB với vai trò thành viên.',
    );
  });

  it('keeps a name with curly quotes inside the quotes that frame it', () => {
    const message = composeOrganizationInviteEmail(
      {
        email: 'invitee@example.com',
        organizationName: 'X” AIHUB yêu cầu bạn đăng nhập lại “',
        role: 'member',
        token: 'invite-token',
        expiresAt,
        inviterUsername: 'alice',
      },
      customerWebBaseUrl,
    );

    const sentence =
      'alice mời bạn tham gia tổ chức “X" AIHUB yêu cầu bạn đăng nhập lại "” trên AIHUB với vai trò thành viên.';
    expect(message.text).toContain(sentence);
    expect(message.html).toContain(sentence.replaceAll('"', '&quot;'));
  });

  it('escapes an organization name in invitation HTML and retains the token-only fallback', () => {
    const organizationName = '<Acme & Sons>';
    const linked = composeOrganizationInviteEmail(
      {
        email: 'invitee@example.com',
        organizationName,
        role: 'member',
        token: 'invite-token',
        expiresAt,
      },
      customerWebBaseUrl,
    );
    const tokenOnly = composeOrganizationInviteEmail({
      email: 'invitee@example.com',
      organizationName,
      role: 'member',
      token: 'invite-token',
      expiresAt,
    });

    expect(linked.html).toContain('&lt;Acme &amp; Sons&gt;');
    expect(linked.html).not.toContain(organizationName);
    expect(tokenOnly.subject).toBe('Lời mời tham gia một tổ chức trên AIHUB');
    expect(tokenOnly.text).toContain('invite-token');
    expect(tokenOnly.text).toContain('thành viên');
    expect(tokenOnly.html).toBeUndefined();
  });

  it.each([
    [
      'enabled',
      'AIHUB two-factor authentication enabled',
      'A TOTP second factor was enabled on your AIHUB account. If you did not make this change, contact AIHUB support immediately.',
    ],
    [
      'removed',
      'AIHUB two-factor authentication removed',
      'The TOTP second factor was removed from your AIHUB account and all refresh and web sessions were ended. If you did not make this change, contact AIHUB support immediately.',
    ],
  ] as const)(
    'preserves the existing %s MFA notification copy',
    (action, subject, text) => {
      expect(
        composeMfaSecurityNotification({
          email: 'person@example.com',
          action,
        }),
      ).toEqual({ recipient: 'person@example.com', subject, text });
    },
  );

  it('validates Customer Web configuration once before composing links', () => {
    expect(normalizeCustomerWebBaseUrl('  ', false, false)).toBeUndefined();
    expect(normalizeCustomerWebBaseUrl(undefined, true, false)).toBeUndefined();
    expect(
      normalizeCustomerWebBaseUrl(
        'https://customer.example.com/app/',
        true,
        true,
      ),
    ).toBe('https://customer.example.com/app');
    expect(() => normalizeCustomerWebBaseUrl(undefined, true, true)).toThrow(
      'CUSTOMER_WEB_BASE_URL is required in production',
    );
    expect(() =>
      normalizeCustomerWebBaseUrl('http://customer.example.com', true, false),
    ).toThrow('HTTPS');
    expect(() =>
      normalizeCustomerWebBaseUrl(
        'https://user:password@customer.example.com',
        false,
        false,
      ),
    ).toThrow('CUSTOMER_WEB_BASE_URL must be an absolute http(s) URL');
    expect(() =>
      normalizeCustomerWebBaseUrl(
        'https://customer.example.com?campaign=welcome',
        false,
        false,
      ),
    ).toThrow('CUSTOMER_WEB_BASE_URL must be an absolute http(s) URL');
    expect(() =>
      normalizeCustomerWebBaseUrl(
        'https://customer.example.com#verification',
        false,
        false,
      ),
    ).toThrow('CUSTOMER_WEB_BASE_URL must be an absolute http(s) URL');
  });
});
