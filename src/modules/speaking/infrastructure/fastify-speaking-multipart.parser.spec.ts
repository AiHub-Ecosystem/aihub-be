import type {
  SpeakingMultipartFieldPart,
  SpeakingMultipartFilePart,
  SpeakingMultipartPart,
  SpeakingMultipartSource,
} from '@/modules/speaking/application/speaking-multipart-parser.port';
import { FastifySpeakingMultipartParser } from './fastify-speaking-multipart.parser';

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
    expect(input.audio.bytes).toHaveLength(AUDIO_BYTES.length);
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
