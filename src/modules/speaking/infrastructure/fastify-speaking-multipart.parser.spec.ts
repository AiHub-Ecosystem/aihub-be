import { AppError } from '@/common/errors/app-error';
import type {
  SpeakingMultipartFieldPart,
  SpeakingMultipartFilePart,
  SpeakingMultipartPart,
  SpeakingMultipartSource,
} from '@/modules/speaking/application/audio/speaking-multipart-parser.port';
import { FastifySpeakingMultipartParser } from '@/modules/speaking/public/fastify-speaking-multipart.parser';

const AUDIO_BYTES = Buffer.alloc(1_024, 1);

function audioPart(
  overrides: Partial<Omit<SpeakingMultipartFilePart, 'type' | 'bytes'>> & {
    readonly bytes?: Uint8Array;
  } = {},
): SpeakingMultipartFilePart {
  const { bytes = AUDIO_BYTES, ...rest } = overrides;
  return {
    type: 'file',
    fieldname: 'audio',
    filename: 'answer.wav',
    contentType: 'audio/wav',
    truncated: () => false,
    ...rest,
    bytes: (async function* streamBytes() {
      yield bytes;
    })(),
  };
}

function fieldPart(
  fieldname: string,
  value: unknown,
  overrides: Partial<
    Omit<SpeakingMultipartFieldPart, 'type' | 'fieldname' | 'value'>
  > = {},
): SpeakingMultipartFieldPart {
  return { type: 'field', fieldname, value, truncated: false, ...overrides };
}

/**
 * A source that hands the parser the parts it is given, in the order it is
 * given them. Nothing here speaks the multipart wire format, which is what lets
 * each rejection be produced by exactly one wrong input.
 */
function sourceOf(
  parts: readonly SpeakingMultipartPart[],
  onPartsError?: () => unknown,
): SpeakingMultipartSource {
  return {
    parts: (): AsyncIterableIterator<SpeakingMultipartPart> => {
      if (onPartsError !== undefined) {
        throw onPartsError();
      }
      return (async function* emit() {
        for (const part of parts) {
          yield part;
        }
      })();
    },
    abort: (): void => undefined,
  };
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

function parser(): FastifySpeakingMultipartParser {
  return new FastifySpeakingMultipartParser();
}

describe('FastifySpeakingMultipartParser accepted body', () => {
  it('reads the audio file and the declared fields', async () => {
    const input = await parser().parse(
      sourceOf([
        fieldPart('part', '2'),
        fieldPart('question_id', 'q_42'),
        audioPart(),
      ]),
      neverAborted(),
    );

    expect(input).toMatchObject({
      audio: { filename: 'answer.wav', contentType: 'audio/wav' },
      part: 2,
      questionId: 'q_42',
      testType: 'Practice',
    });
    expect(input.audio.blob.size).toBe(AUDIO_BYTES.length);
    expect(Buffer.from(await input.audio.blob.arrayBuffer())).toEqual(
      Buffer.from(AUDIO_BYTES),
    );
  });

  it('accepts the fields in any order, including after the audio file', async () => {
    const input = await parser().parse(
      sourceOf([
        audioPart(),
        fieldPart('part', '1'),
        fieldPart('question_id', 'q_1'),
      ]),
      neverAborted(),
    );

    expect(input.part).toBe(1);
  });
});

describe('FastifySpeakingMultipartParser rejection branches', () => {
  it('refuses a body whose field stream fails, which is what a malformed boundary looks like', async () => {
    await expect(
      parser().parse(
        sourceOf([], () => new Error('Unexpected end of multipart stream')),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses a body whose `part` field is missing', async () => {
    await expect(
      parser().parse(
        sourceOf([fieldPart('question_id', 'q_1'), audioPart()]),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    await expect(
      parser().parse(
        sourceOf([
          fieldPart('part', '1'),
          fieldPart('question_id', 'q_1'),
          fieldPart('candidate_name', 'someone'),
          audioPart(),
        ]),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses a field carrying a NUL character', async () => {
    await expect(
      parser().parse(
        sourceOf([
          fieldPart('part', '1'),
          fieldPart('question_id', 'q_\u00001'),
          audioPart(),
        ]),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses the same field twice rather than letting the last one win', async () => {
    await expect(
      parser().parse(
        sourceOf([
          fieldPart('part', '1'),
          fieldPart('part', '2'),
          fieldPart('question_id', 'q_1'),
          audioPart(),
        ]),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses a field that carries no text', async () => {
    await expect(
      parser().parse(
        sourceOf([
          fieldPart('part', '1'),
          fieldPart('question_id', 'q_1'),
          fieldPart('transcript', { nested: true }),
          audioPart(),
        ]),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('reports a truncated field as too large, not as malformed', async () => {
    await expect(
      parser().parse(
        sourceOf([
          fieldPart('part', '1'),
          fieldPart('question_id', 'q_1'),
          fieldPart('prompt_text', 'x'.repeat(10), { truncated: true }),
          audioPart(),
        ]),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('reports a truncated audio file as too large', async () => {
    await expect(
      parser().parse(
        sourceOf([
          fieldPart('part', '1'),
          fieldPart('question_id', 'q_1'),
          audioPart({ truncated: () => true }),
        ]),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  // The file-size ceiling is enforced by the multipart plugin, which signals it
  // as its own error rather than a truncation flag.
  it("translates the plugin's file-size error into the same too-large answer", async () => {
    await expect(
      parser().parse(
        sourceOf([], () => ({
          code: 'FST_REQ_FILE_TOO_LARGE',
          message: 'request file too large',
        })),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('refuses audio smaller than the contract minimum', async () => {
    await expect(
      parser().parse(
        sourceOf([
          fieldPart('part', '1'),
          fieldPart('question_id', 'q_1'),
          audioPart({ bytes: Buffer.alloc(99, 1) }),
        ]),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses an audio field under another name', async () => {
    await expect(
      parser().parse(
        sourceOf([
          fieldPart('part', '1'),
          fieldPart('question_id', 'q_1'),
          audioPart({ fieldname: 'recording' }),
        ]),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses a second audio file', async () => {
    await expect(
      parser().parse(
        sourceOf([
          fieldPart('part', '1'),
          fieldPart('question_id', 'q_1'),
          audioPart(),
          audioPart({ filename: 'again.wav' }),
        ]),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses an audio format the provider does not accept', async () => {
    await expect(
      parser().parse(
        sourceOf([
          fieldPart('part', '1'),
          fieldPart('question_id', 'q_1'),
          audioPart({ filename: 'answer.flac' }),
        ]),
        neverAborted(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('reports an aborted upload as a retryable timeout rather than a bad request', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      parser().parse(
        sourceOf([fieldPart('part', '1'), audioPart()]),
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: 'AI_SERVICE_TIMEOUT',
      retryable: true,
    });
  });
});

describe('FastifySpeakingMultipartParser rejection diagnostics (#2014)', () => {
  async function rejectionOf(
    parts: readonly SpeakingMultipartPart[],
    options: Readonly<{
      authenticated?: boolean;
      onPartsError?: () => unknown;
      parseQuestionV2?: boolean;
    }> = {},
  ): Promise<Record<string, unknown>> {
    const instance = parser();
    const method =
      options.parseQuestionV2 === true
        ? instance.parseQuestionV2.bind(instance)
        : instance.parse.bind(instance);
    try {
      await method(
        sourceOf(parts, options.onPartsError),
        neverAborted(),
        options.authenticated ?? false,
      );
    } catch (error) {
      if (error instanceof AppError) {
        return error as unknown as Record<string, unknown>;
      }
      throw error;
    }
    throw new Error('Expected the parser to reject');
  }

  const validFields = [fieldPart('part', '1'), fieldPart('question_id', 'q_1')];

  it.each([
    [
      'an unknown field',
      'multipart:unknown-field',
      [...validFields, fieldPart('candidate_name', 'someone'), audioPart()],
    ],
    [
      'unstorable text',
      'multipart:unstorable-field',
      [
        fieldPart('part', '1'),
        fieldPart('question_id', 'q_\u00001'),
        audioPart(),
      ],
    ],
    [
      'a duplicate field',
      'multipart:duplicate-field',
      [
        fieldPart('part', '1'),
        fieldPart('part', '2'),
        fieldPart('question_id', 'q_1'),
        audioPart(),
      ],
    ],
    [
      'a non-text field',
      'multipart:non-text-field',
      [...validFields, fieldPart('transcript', { nested: true }), audioPart()],
    ],
    [
      'a schema mismatch',
      'multipart:schema',
      [fieldPart('question_id', 'q_1'), audioPart()],
    ],
    [
      'a second file part',
      'multipart:audio-field',
      [...validFields, audioPart(), audioPart({ filename: 'again.wav' })],
    ],
    [
      'an unsupported extension',
      'multipart:audio-format',
      [...validFields, audioPart({ filename: 'answer.flac' })],
    ],
    [
      'audio below the minimum',
      'multipart:audio-too-small',
      [...validFields, audioPart({ bytes: Buffer.alloc(99, 1) })],
    ],
    ['a missing audio file', 'multipart:audio-missing', validFields],
  ])('names %s with its own token', async (_label, token, parts) => {
    const rejection = await rejectionOf(parts);

    expect(rejection['diagnostic']).toBe(token);
    expect(rejection['diagnostic']).toMatch(/^multipart:[a-z-]+$/);
  });

  it('names a framework limit error with its own token', async () => {
    const rejection = await rejectionOf([], {
      onPartsError: () => ({ code: 'FST_FIELDS_LIMIT', message: 'limit' }),
    });

    expect(rejection['diagnostic']).toBe('multipart:fields-limit');
  });

  it('gives every token a fixed shape and no caller-supplied text', async () => {
    const rejection = await rejectionOf([
      ...validFields,
      fieldPart('secret_caller_key', 'secret_caller_value'),
      audioPart(),
    ]);
    const diagnostic = String(rejection['diagnostic']);

    expect(diagnostic).not.toContain('secret_caller_key');
    expect(diagnostic).not.toContain('secret_caller_value');
  });

  it('names the refused field back only to an authenticated caller', async () => {
    const parts = [
      ...validFields,
      fieldPart('candidate_name', 'someone'),
      audioPart(),
    ];

    const authenticated = await rejectionOf(parts, { authenticated: true });
    expect(authenticated['details']).toEqual({
      '/candidate_name': 'Unexpected property',
    });

    const anonymous = await rejectionOf(parts);
    expect(anonymous['details']).toBeUndefined();
  });

  it('reports a bad v2 question body against the v2 schema', async () => {
    const rejection = await rejectionOf(
      [fieldPart('part', '4'), fieldPart('question_id', 'q_1'), audioPart()],
      { parseQuestionV2: true, authenticated: true },
    );

    expect(rejection['diagnostic']).toBe('multipart:schema');
    expect(Object.keys(rejection['details'] as object)).toEqual(['/part']);
  });
});
