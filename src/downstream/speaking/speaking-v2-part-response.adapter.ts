import {
  type SpeakingV2PartResult,
  SpeakingV2PartResultSchema,
} from '@/contracts/speaking/v2/part-result';
import { Value } from '@sinclair/typebox/value';

import {
  speakingV2Projection,
  validateSpeakingV2Result,
} from './speaking-v2-response.shared';

export function parseSpeakingV2PartResult(body: unknown): SpeakingV2PartResult {
  const projected = speakingV2Projection(body);
  validateSpeakingV2Result(SpeakingV2PartResultSchema, projected);
  return Value.Parse(SpeakingV2PartResultSchema, projected);
}
