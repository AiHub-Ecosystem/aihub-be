import { Controller, Get, Header, Inject, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { Value } from '@sinclair/typebox/value';
import { PUBLIC_ROUTES } from '../../../catalog/public-routes';
import { invalidRequest } from '../../../common/errors/invalid-request';
import {
  type SpeakingPart,
  type SpeakingQuestionContract,
  SpeakingQuestionsQuerySchema,
} from '../../../contracts/speaking/questions';
import {
  SPEAKING_AUDIO_STORAGE,
  type SpeakingAudioStoragePort,
} from '../application/speaking-audio-storage.port';
import { listSpeakingQuestions } from '../application/speaking-question-catalog';

type SpeakingQuestionsEnvelope = {
  readonly data: {
    readonly part: SpeakingPart | null;
    readonly questions: readonly SpeakingQuestionContract[];
  };
  readonly meta: {
    readonly request_id: string;
    readonly service: 'speaking';
    readonly operation: 'speaking.questions';
  };
};

function parsePart(value: unknown): SpeakingPart | undefined {
  if (value === undefined) {
    return undefined;
  }

  const query = { part: value };
  if (!Value.Check(SpeakingQuestionsQuerySchema, query)) {
    throw invalidRequest();
  }

  switch (value) {
    case '1':
      return 1;
    case '2':
      return 2;
    case '3':
      return 3;
    default:
      throw invalidRequest();
  }
}

@Controller()
export class SpeakingQuestionsController {
  constructor(
    @Inject(SPEAKING_AUDIO_STORAGE)
    private readonly storage: SpeakingAudioStoragePort,
  ) {}

  @Get(PUBLIC_ROUTES['speaking.questions'].path)
  @Header('Cache-Control', 'no-store')
  async list(
    @Req() request: FastifyRequest,
    @Query('part') partValue?: unknown,
  ): Promise<SpeakingQuestionsEnvelope> {
    const part = parsePart(partValue);
    const questions = await listSpeakingQuestions(this.storage, part);

    return {
      data: {
        part: part ?? null,
        questions: questions.map((question) => ({
          question_id: question.id,
          part: question.part,
          prompt_text: question.promptText,
          audio_url: question.audioUrl,
        })),
      },
      meta: {
        request_id: String(request.id),
        service: 'speaking',
        operation: 'speaking.questions',
      },
    };
  }
}
