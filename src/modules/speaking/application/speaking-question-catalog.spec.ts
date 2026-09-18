import {
  listSpeakingQuestions,
  speakingQuestionCatalog,
  speakingQuestionCount,
} from './speaking-question-catalog';

describe('speaking question catalog', () => {
  it('contains the 14/4/4 sample distribution and stable object keys', () => {
    expect(speakingQuestionCount()).toBe(22);
    expect(speakingQuestionCatalog(1)).toHaveLength(14);
    expect(speakingQuestionCatalog(2)).toHaveLength(4);
    expect(speakingQuestionCatalog(3)).toHaveLength(4);

    const first = speakingQuestionCatalog(1)[0];
    expect(first).toBeDefined();
    expect(first?.promptText.endsWith('?')).toBe(true);
    expect(first?.id).toMatch(/^p1_/);
    expect(first?.audioObjectKey).toMatch(
      /^speaking-samples\/part-1\/.*\.webm$/,
    );
  });

  it('adds storage URLs without exposing object keys', async () => {
    const storage = {
      getReadUrl: jest.fn(
        async (objectKey: string) => `https://s3.wispace.app/${objectKey}`,
      ),
    };

    const questions = await listSpeakingQuestions(storage, 2);

    expect(questions).toHaveLength(4);
    expect(storage.getReadUrl).toHaveBeenCalledTimes(4);
    expect(questions[0]).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^p2_/),
        part: 2,
        audioUrl: expect.stringMatching(/^https:\/\/s3\.wispace\.app\//),
      }),
    );
    expect(questions[0]).not.toHaveProperty('audioObjectKey');
  });
});
