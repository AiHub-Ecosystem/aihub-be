import type { FastifyRequest } from 'fastify';

import type { SpeakingAudioStoragePort } from '../application/speaking-audio-storage.port';
import { SpeakingQuestionsController } from './speaking-questions.controller';

describe('SpeakingQuestionsController', () => {
  function controller() {
    const storage: SpeakingAudioStoragePort = {
      getReadUrl: jest.fn(
        async (objectKey: string) => `https://s3.wispace.app/${objectKey}`,
      ),
    };
    return {
      controller: new SpeakingQuestionsController(storage),
      storage,
    };
  }

  it('returns a filtered public catalog with presigned audio URLs', async () => {
    const { controller: subject, storage } = controller();

    const response = await subject.list(
      { id: 'req_questions' } as unknown as FastifyRequest,
      '3',
    );

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
    expect(storage.getReadUrl).toHaveBeenCalledTimes(4);
  });

  it('rejects an invalid part before touching storage', async () => {
    const { controller: subject, storage } = controller();

    await expect(
      subject.list({ id: 'req_questions' } as unknown as FastifyRequest, '4'),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(storage.getReadUrl).not.toHaveBeenCalled();
  });
});
