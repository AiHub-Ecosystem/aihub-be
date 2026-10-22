import type { EmailMessage } from '@/modules/auth/email-delivery/application/email-sender.port';
import { ResendEmailSender } from './resend-email.sender';

describe('ResendEmailSender', () => {
  const message: EmailMessage = {
    recipient: 'person@example.com',
    subject: 'Subject from Auth',
    text: 'Plain text from Auth',
    html: '<p>HTML from Auth</p>',
  };

  it('maps a finished message to a bounded Resend request', async () => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'AIHUB <no-reply@example.com>',
      async (input, init) => {
        calls.push({ input, init });
        return { status: 200, headers: { get: () => null } };
      },
    );

    await sender.send(message, { idempotencyKey: 'edr_one' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('https://api.resend.com/emails');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer resend-secret',
        'content-type': 'application/json',
        'Idempotency-Key': 'edr_one',
      },
      signal: expect.any(AbortSignal),
    });
    const requestBody = calls[0]?.init?.body;
    if (typeof requestBody !== 'string') {
      throw new Error('Expected a serialized Resend request body');
    }
    expect(JSON.parse(requestBody)).toEqual({
      from: 'AIHUB <no-reply@example.com>',
      to: ['person@example.com'],
      subject: 'Subject from Auth',
      text: 'Plain text from Auth',
      html: '<p>HTML from Auth</p>',
    });
  });

  it('omits HTML when the finished message has none', async () => {
    let body = '';
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'no-reply@example.com',
      async (_input, init) => {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected a serialized Resend request body');
        }
        body = init.body;
        return { status: 200, headers: { get: () => null } };
      },
    );

    await sender.send({
      recipient: 'person@example.com',
      subject: 'Subject',
      text: 'Plain text',
    });

    expect(JSON.parse(body)).toEqual({
      from: 'no-reply@example.com',
      to: ['person@example.com'],
      subject: 'Subject',
      text: 'Plain text',
    });
  });

  it('returns safe metadata for provider rejection without exposing its body', async () => {
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'no-reply@example.com',
      async () => ({
        status: 422,
        headers: { get: () => null },
        body: 'provider-private-response',
      }),
    );

    await expect(sender.send(message)).resolves.toEqual({
      status: 422,
      retryAfter: undefined,
    });
  });

  it('returns only the provider status and Retry-After header', async () => {
    const response = {
      ok: false,
      status: 429,
      headers: {
        get: (name: string) => (name === 'retry-after' ? '30' : null),
      },
      body: 'provider-private-response',
    };
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'no-reply@example.com',
      async () => response,
    );

    await expect(sender.send(message)).resolves.toEqual({
      status: 429,
      retryAfter: '30',
    });
  });

  it('requires a non-empty sender address', () => {
    expect(
      () =>
        new ResendEmailSender({ apiKey: 'resend-secret' }, '   ', async () => ({
          status: 200,
          headers: { get: () => null },
        })),
    ).toThrow('RESEND_FROM is required');
  });
});
