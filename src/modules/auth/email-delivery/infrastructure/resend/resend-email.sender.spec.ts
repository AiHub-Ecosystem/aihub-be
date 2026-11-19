import {
  type EmailMessage,
  EmailProviderTransportError,
} from '@/modules/auth/email-delivery/application/email-sender.port';
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
    });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
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
        text: async () => 'provider-private-response',
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
      text: async () => 'provider-private-response',
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

  it('classifies a fetch rejection without retaining the thrown error', async () => {
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'no-reply@example.com',
      async () => {
        throw new Error('private transport details');
      },
    );

    const rejection = sender.send(message);
    await expect(rejection).rejects.toMatchObject({
      name: 'EmailProviderTransportError',
      message: 'Email provider transport failed',
    });
    await expect(rejection).rejects.toBeInstanceOf(EmailProviderTransportError);
  });

  it('does not classify sender serialization errors as provider transport failures', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const fetcher = jest.fn(async () => ({
      status: 200,
      headers: { get: () => null },
    }));
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'no-reply@example.com',
      fetcher,
    );

    await expect(
      sender.send({ ...message, subject: circular as unknown as string }),
    ).rejects.not.toBeInstanceOf(EmailProviderTransportError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels the body of every non-409 response so its connection is released', async () => {
    for (const status of [200, 422, 429, 500]) {
      const cancel = jest.fn(async () => undefined);
      const text = jest.fn(async () => '{}');
      const sender = new ResendEmailSender(
        { apiKey: 'resend-secret' },
        'no-reply@example.com',
        async () => ({
          status,
          headers: { get: () => null },
          body: { cancel },
          text,
        }),
      );

      await sender.send(message, { idempotencyKey: 'edr_one' });

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(text).not.toHaveBeenCalled();
    }
  });

  it('still answers when cancelling the body fails', async () => {
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'no-reply@example.com',
      async () => ({
        status: 202,
        headers: { get: () => null },
        body: {
          cancel: async () => {
            throw new Error('already closed');
          },
        },
      }),
    );

    await expect(sender.send(message)).resolves.toEqual({
      status: 202,
      retryAfter: undefined,
    });
  });

  it.each([
    ['concurrent_idempotent_requests', 'concurrent'],
    ['invalid_idempotent_request', 'payload_changed'],
  ])(
    'reads the 409 error name %s as the %s idempotency conflict',
    async (name, conflict) => {
      const sender = new ResendEmailSender(
        { apiKey: 'resend-secret' },
        'no-reply@example.com',
        async () => ({
          status: 409,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({ statusCode: 409, name, message: 'private' }),
        }),
      );

      await expect(sender.send(message)).resolves.toEqual({
        status: 409,
        retryAfter: undefined,
        idempotencyConflict: conflict,
      });
    },
  );

  it.each([
    ['an unknown error name', JSON.stringify({ name: 'conflict' })],
    ['an inherited property name', JSON.stringify({ name: 'toString' })],
    ['a body that is not JSON', 'not json'],
    [
      'an oversized body',
      JSON.stringify({
        name: 'invalid_idempotent_request',
        message: 'x'.repeat(5_000),
      }),
    ],
  ])('reports no conflict for a 409 with %s', async (_case, body) => {
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'no-reply@example.com',
      async () => ({
        status: 409,
        headers: { get: () => null },
        text: async () => body,
      }),
    );

    await expect(sender.send(message)).resolves.toEqual({
      status: 409,
      retryAfter: undefined,
    });
  });

  it('stops reading a 409 body at the limit and cancels the stream', async () => {
    let cancelled = false;
    const chunk = new TextEncoder().encode('x'.repeat(1_024));
    const total = 16;
    let sent = 0;
    // Finite, so a reader that ignored the limit would drain all sixteen chunks.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          sent += 1;
          controller.enqueue(chunk);
          if (sent === total) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'no-reply@example.com',
      async () => new Response(body, { status: 409 }),
    );

    await expect(sender.send(message)).resolves.toEqual({
      status: 409,
      retryAfter: undefined,
    });
    expect(cancelled).toBe(true);
    // 4 KiB is four chunks; the fifth crosses the limit and is the last one read.
    expect(sent).toBe(5);
  });

  it.each([
    [4_096, 'payload_changed'],
    [4_097, undefined],
  ] as const)(
    'classifies a valid 409 document of %i bytes as %s',
    async (bytes, conflict) => {
      const head = JSON.stringify({
        name: 'invalid_idempotent_request',
        pad: '',
      });
      const document = JSON.stringify({
        name: 'invalid_idempotent_request',
        pad: 'x'.repeat(bytes - new TextEncoder().encode(head).byteLength),
      });
      expect(new TextEncoder().encode(document).byteLength).toBe(bytes);
      const sender = new ResendEmailSender(
        { apiKey: 'resend-secret' },
        'no-reply@example.com',
        async () => new Response(document, { status: 409 }),
      );

      await expect(sender.send(message)).resolves.toEqual({
        status: 409,
        retryAfter: undefined,
        ...(conflict === undefined ? {} : { idempotencyConflict: conflict }),
      });
    },
  );

  it('applies the byte limit to a text-only 409 body, not its character count', async () => {
    const document = JSON.stringify({
      name: 'invalid_idempotent_request',
      pad: 'é'.repeat(2_100),
    });
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'no-reply@example.com',
      async () => ({
        status: 409,
        headers: { get: () => null },
        text: async () => document,
      }),
    );

    await expect(sender.send(message)).resolves.toEqual({
      status: 409,
      retryAfter: undefined,
    });
  });

  it('classifies a small streamed 409 body', async () => {
    const sender = new ResendEmailSender(
      { apiKey: 'resend-secret' },
      'no-reply@example.com',
      async () =>
        new Response(JSON.stringify({ name: 'invalid_idempotent_request' }), {
          status: 409,
        }),
    );

    await expect(sender.send(message)).resolves.toEqual({
      status: 409,
      retryAfter: undefined,
      idempotencyConflict: 'payload_changed',
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
