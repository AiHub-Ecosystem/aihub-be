import type { FastifyRequest } from 'fastify';

import type { SpeakingAudioStoragePort } from '@/modules/speaking/application/speaking-audio-storage.port';
import { SpeakingQuestionsController } from './speaking-questions.controller';

describe('SpeakingQuestionsController', () => {
  function controller() {
    const getReadUrl = jest.fn(
      async (objectKey: string) => `https://s3.wispace.app/${objectKey}`,
    );
    const storage: SpeakingAudioStoragePort = {
      getReadUrl,
    };
    return {
      controller: new SpeakingQuestionsController(storage),
      getReadUrl,
    };
  }

  it('returns a filtered public catalog with presigned audio URLs', async () => {
    const { controller: subject, getReadUrl } = controller();

    const response = await subject.list({
      id: 'req_questions',
      query: { part: '3' },
    } as unknown as FastifyRequest);

    expect(response.data.part).toBe(3);
    expect(response.data.questions).toHaveLength(4);
    expect(response.data.questions[0]).toEqual(
      expect.objectContaining({
        question_id: expect.stringMatching(/^p3_/),
        part: 3,
        prompt_text: expect.stringMatching(/\?$/),
        audio_url: expect.stringMatching(/^https:\/\/s3\.wispace\.app\//),
      }),
    );
    expect(getReadUrl.mock.calls).toHaveLength(4);
  });

  it('rejects an undeclared query parameter before touching storage', async () => {
    const { controller: subject, getReadUrl } = controller();

    await expect(
      subject.list({
        id: 'req_questions',
        query: { unexpected: 'value' },
      } as unknown as FastifyRequest),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(getReadUrl.mock.calls).toHaveLength(0);
  });

  it('rejects a misspelled part name before touching storage', async () => {
    const { controller: subject, getReadUrl } = controller();

    await expect(
      subject.list({
        id: 'req_questions',
        query: { par: '3' },
      } as unknown as FastifyRequest),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(getReadUrl.mock.calls).toHaveLength(0);
  });

  it('rejects repeated part values before touching storage', async () => {
    const { controller: subject, getReadUrl } = controller();

    await expect(
      subject.list({
        id: 'req_questions',
        query: { part: ['1', '2'] },
      } as unknown as FastifyRequest),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(getReadUrl.mock.calls).toHaveLength(0);
  });

  it('rejects an invalid part before touching storage', async () => {
    const { controller: subject, getReadUrl } = controller();

    await expect(
      subject.list({
        id: 'req_questions',
        query: { part: '4' },
      } as unknown as FastifyRequest),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(getReadUrl.mock.calls).toHaveLength(0);
  });
});
