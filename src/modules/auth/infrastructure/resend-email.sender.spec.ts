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
});
