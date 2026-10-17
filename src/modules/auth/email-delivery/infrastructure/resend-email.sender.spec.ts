import { ResendEmailSender } from './resend-email.sender';

describe('ResendEmailSender', () => {
  it('sends an opaque token through the provider with a bounded request', async () => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'AIHUB <no-reply@example.com>',
      async (input, init) => {
        calls.push({ input, init });
        return { ok: true };
      },
    );

    await sender.sendVerificationEmail({
      email: 'person@example.com',
      token: 'opaque-token',
      expiresAt: new Date('2026-09-20T00:00:00.000Z'),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('https://api.resend.com/emails');
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer resend-secret',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      from: 'AIHUB <no-reply@example.com>',
      to: ['person@example.com'],
      subject: 'Xác minh địa chỉ email AIHUB',
    });
    const body = String(calls[0]?.init?.body);
    expect(body).toContain('opaque-token');
    expect(body).toContain('lúc 07:00 20 tháng 9, 2026 (giờ Việt Nam)');
    expect(body).not.toContain('2026-09-20T00:00:00.000Z');
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps non-success provider responses without exposing provider bodies', async () => {
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'no-reply@example.com',
      async () => ({ ok: false }),
    );

    await expect(
      sender.sendVerificationEmail({
        email: 'person@example.com',
        token: 'opaque-token',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow('Resend email delivery failed');
  });

  it('sends the reset token and expiry without constructing a frontend URL', async () => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'AIHUB <no-reply@example.com>',
      async (input, init) => {
        calls.push({ input, init });
        return { ok: true };
      },
    );

    await sender.sendPasswordResetEmail({
      email: 'person@example.com',
      token: 'reset-token',
      expiresAt: new Date('2026-09-20T01:00:00.000Z'),
    });

    const body = String(calls[0]?.init?.body);
    expect(JSON.parse(body)).toMatchObject({
      subject: 'Reset your AIHUB password',
      to: ['person@example.com'],
    });
    expect(body).toContain('reset-token');
    expect(body).toContain('2026-09-20T01:00:00.000Z');
    expect(body).not.toContain('http');
  });

  it('sends the invite token, organization, and role without constructing a frontend URL', async () => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'AIHUB <no-reply@example.com>',
      async (input, init) => {
        calls.push({ input, init });
        return { ok: true };
      },
    );

    await sender.sendOrganizationInviteEmail({
      email: 'invitee@example.com',
      organizationName: 'Acme',
      role: 'member',
      token: 'invite-token',
      expiresAt: new Date('2026-09-21T00:00:00.000Z'),
    });

    const body = String(calls[0]?.init?.body);
    expect(JSON.parse(body)).toMatchObject({
      subject: 'You are invited to Acme on AIHUB',
      to: ['invitee@example.com'],
    });
    expect(body).toContain('invite-token');
    expect(body).toContain('member');
    expect(body).toContain('2026-09-21T00:00:00.000Z');
    // The acceptance endpoint does not exist yet; no URL is guessed here.
    expect(body).not.toContain('http');
  });

  it('fails invite delivery without exposing the provider body', async () => {
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'no-reply@example.com',
      async () => ({ ok: false }),
    );

    await expect(
      sender.sendOrganizationInviteEmail({
        email: 'invitee@example.com',
        organizationName: 'Acme',
        role: 'member',
        token: 'invite-token',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow('Resend email delivery failed');
  });

  it('sends MFA security notices without factor secrets or recovery codes', async () => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'AIHUB <no-reply@example.com>',
      async (input, init) => {
        calls.push({ input, init });
        return { ok: true };
      },
    );

    await sender.sendMfaSecurityNotification(
      { email: 'person@example.com', action: 'removed' },
      { idempotencyKey: 'edr_test' },
    );

    const body = String(calls[0]?.init?.body);
    expect(JSON.parse(body)).toMatchObject({
      to: ['person@example.com'],
      subject: 'AIHUB two-factor authentication removed',
    });
    expect(body).toContain('all refresh and web sessions were ended');
    expect(body).not.toContain('secret');
    expect(body).not.toContain('recovery');
    expect(calls[0]?.init?.headers).toMatchObject({
      'Idempotency-Key': 'edr_test',
    });
  });

  describe('with a configured Customer Web base URL', () => {
    function senderWithBase(
      base: string | undefined,
      requireHttps = false,
      requireCustomerWebUrl = requireHttps,
    ) {
      const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
      const sender = new ResendEmailSender(
        { apiKey: 'resend-secret' },
        'AIHUB <no-reply@example.com>',
        async (input, init) => {
          calls.push({ input, init });
          return { ok: true };
        },
        base,
        requireHttps,
        requireCustomerWebUrl,
      );
      return { sender, calls };
    }

    it('sends a link-first multipart verification email with an encoded token', async () => {
      const { sender, calls } = senderWithBase(
        'https://customer.example.com/web&more/',
      );

      await sender.sendVerificationEmail({
        email: 'person@example.com',
        token: 'a+b/c=d',
        expiresAt: new Date('2026-09-20T00:00:00.000Z'),
      });

      const body = String(calls[0]?.init?.body);
      const payload = JSON.parse(body) as { html?: string; text?: string };
      const link =
        'https://customer.example.com/web&more/verify-email?token=a%2Bb%2Fc%3Dd';
      const htmlLink =
        'https://customer.example.com/web&amp;more/verify-email?token=a%2Bb%2Fc%3Dd';

      expect(payload.html).toContain(`<a href="${htmlLink}"`);
      expect(payload.html).toContain('<html lang="vi">');
      expect(payload.html).toContain('Xác nhận email');
      expect(payload.html).toContain('lúc 07:00 20 tháng 9, 2026');
      expect(payload.html).toContain('(giờ Việt Nam)');
      expect(payload.html).toContain(
        'Liên kết này chỉ dùng để kích hoạt tài khoản một lần. Nếu email đã được xác minh, mở lại liên kết vẫn sẽ hiển thị xác nhận thành công.',
      );
      expect(payload.text).toContain(link);
      expect(payload.text).toContain(
        'lúc 07:00 20 tháng 9, 2026 (giờ Việt Nam)',
      );
      expect(payload.text).toContain(
        'Liên kết này chỉ dùng để kích hoạt tài khoản một lần. Nếu email đã được xác minh, mở lại liên kết vẫn sẽ hiển thị xác nhận thành công.',
      );
      expect(payload.text).not.toContain('one-time verification token');
      expect(body).not.toContain('a+b/c=d');
    });

    it('appends the password-reset deep link', async () => {
      const { sender, calls } = senderWithBase('https://customer.example.com/');

      await sender.sendPasswordResetEmail({
        email: 'person@example.com',
        token: 'reset-token',
        expiresAt: new Date('2026-09-20T01:00:00.000Z'),
      });

      const body = String(calls[0]?.init?.body);
      expect(body).toContain('reset-token');
      expect(body).toContain(
        'https://customer.example.com/reset-password?token=reset-token',
      );
    });

    it('appends the invitation deep link', async () => {
      const { sender, calls } = senderWithBase('https://customer.example.com');

      await sender.sendOrganizationInviteEmail({
        email: 'invitee@example.com',
        organizationName: 'Acme',
        role: 'member',
        token: 'invite-token',
        expiresAt: new Date('2026-09-21T00:00:00.000Z'),
      });

      const body = String(calls[0]?.init?.body);
      expect(body).toContain('invite-token');
      expect(body).toContain(
        'https://customer.example.com/invite?token=invite-token',
      );
    });

    it('percent-encodes the token inside the deep link', async () => {
      const { sender, calls } = senderWithBase('https://customer.example.com');

      await sender.sendPasswordResetEmail({
        email: 'person@example.com',
        token: 'a+b/c=d',
        expiresAt: new Date('2026-09-20T01:00:00.000Z'),
      });

      const body = String(calls[0]?.init?.body);
      expect(body).toContain('token=a%2Bb%2Fc%3Dd');
      expect(body).not.toContain('token=a+b/c=d');
    });

    it('keeps emails token-only when the base URL is blank', async () => {
      const { sender, calls } = senderWithBase('   ');

      await sender.sendPasswordResetEmail({
        email: 'person@example.com',
        token: 'reset-token',
        expiresAt: new Date('2026-09-20T01:00:00.000Z'),
      });

      const body = String(calls[0]?.init?.body);
      expect(body).toContain('reset-token');
      expect(body).not.toContain('http');
    });

    it('fails closed at construction for a non-http base URL', () => {
      expect(
        () =>
          new ResendEmailSender(
            { apiKey: 'resend-secret' },
            'no-reply@example.com',
            async () => ({ ok: true }),
            'javascript:alert(1)',
          ),
      ).toThrow('CUSTOMER_WEB_BASE_URL must be an absolute http(s) URL');
    });

    it('requires an HTTPS base URL in production', () => {
      expect(() => senderWithBase(undefined, true)).toThrow(
        'CUSTOMER_WEB_BASE_URL is required in production',
      );
      expect(() => senderWithBase('http://customer.example.com', true)).toThrow(
        'HTTPS',
      );
      expect(() =>
        senderWithBase('https://customer.example.com/customer/', true),
      ).not.toThrow();
    });

    it('allows token-only email in the production sandbox while keeping configured links HTTPS', async () => {
      const { sender, calls } = senderWithBase(undefined, true, false);

      await sender.sendVerificationEmail({
        email: 'person@example.com',
        token: 'sandbox-token',
        expiresAt: new Date('2026-09-20T01:00:00.000Z'),
      });

      const body = String(calls[0]?.init?.body);
      expect(body).toContain('sandbox-token');
      expect(body).not.toContain('http');
      expect(() =>
        senderWithBase('http://sandbox.example.com', true, false),
      ).toThrow('HTTPS');
    });

    it.each([
      'https://user:password@customer.example.com',
      'https://customer.example.com?campaign=welcome',
      'https://customer.example.com#verify',
    ])('rejects ambiguous Customer Web URL %s', (base) => {
      expect(() => senderWithBase(base)).toThrow(
        'CUSTOMER_WEB_BASE_URL must be an absolute http(s) URL',
      );
    });
  });

  describe('idempotency key', () => {
    const input = {
      email: 'person@example.com',
      token: 'opaque-token',
      expiresAt: new Date('2026-09-20T00:00:00.000Z'),
    };

    function recordingSender(): {
      sender: ResendEmailSender;
      keys: (string | undefined)[];
    } {
      const keys: (string | undefined)[] = [];
      const sender = new ResendEmailSender(
        { apiKey: 'resend-secret' },
        'AIHUB <no-reply@example.com>',
        async (_input, init) => {
          keys.push(
            (init?.headers as Record<string, string> | undefined)?.[
              'Idempotency-Key'
            ],
          );
          return { ok: true };
        },
      );
      return { sender, keys };
    }

    it('presents the caller key on every email kind', async () => {
      const { sender, keys } = recordingSender();

      await sender.sendVerificationEmail(input, {
        idempotencyKey: 'edr_one',
      });
      await sender.sendPasswordResetEmail(input, { idempotencyKey: 'edr_one' });
      await sender.sendOrganizationInviteEmail(
        { ...input, organizationName: 'Resonance', role: 'admin' },
        { idempotencyKey: 'edr_one' },
      );

      expect(keys).toEqual(['edr_one', 'edr_one', 'edr_one']);
    });

    it('sends no key when the caller has none to send', async () => {
      const { sender, keys } = recordingSender();

      await sender.sendVerificationEmail(input);

      expect(keys).toEqual([undefined]);
    });
  });
});
