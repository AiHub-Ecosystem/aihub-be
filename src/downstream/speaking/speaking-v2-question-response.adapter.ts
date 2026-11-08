import {
  type SpeakingV2QuestionResult,
  SpeakingV2QuestionResultSchema,
} from '@/contracts/speaking/v2/question-result';
import { Value } from '@sinclair/typebox/value';

import {
  speakingV2Projection,
  validateSpeakingV2Result,
} from './speaking-v2-response.shared';

export function parseSpeakingV2QuestionResult(
  body: unknown,
): SpeakingV2QuestionResult {
  const projected = speakingV2Projection(body);
  validateSpeakingV2Result(SpeakingV2QuestionResultSchema, projected);
  return Value.Parse(SpeakingV2QuestionResultSchema, projected);
}
