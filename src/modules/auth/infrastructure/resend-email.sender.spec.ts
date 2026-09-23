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
      subject: 'Verify your AIHUB email address',
    });
    expect(String(calls[0]?.init?.body)).toContain('opaque-token');
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

  describe('with a configured Customer Web base URL', () => {
    function senderWithBase(base: string | undefined) {
      const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
      const sender = new ResendEmailSender(
        { apiKey: 'resend-secret' },
        'AIHUB <no-reply@example.com>',
        async (input, init) => {
          calls.push({ input, init });
          return { ok: true };
        },
        base,
      );
      return { sender, calls };
    }

    it('appends the verification deep link alongside the opaque token', async () => {
      const { sender, calls } = senderWithBase('https://customer.example.com');

      await sender.sendVerificationEmail({
        email: 'person@example.com',
        token: 'opaque-token',
        expiresAt: new Date('2026-09-20T00:00:00.000Z'),
      });

      const body = String(calls[0]?.init?.body);
      expect(body).toContain('opaque-token');
      expect(body).toContain(
        'https://customer.example.com/verify-email?token=opaque-token',
      );
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
  });
});
