import type { SpeakingV2TestResult } from '@/contracts/speaking/v2/test-result';
import { SpeakingV2TestResultSchema } from '@/contracts/speaking/v2/test-result';
import { Value } from '@sinclair/typebox/value';

import {
  speakingV2Projection,
  validateSpeakingV2Result,
} from './speaking-v2-response.shared';

export function parseSpeakingV2TestResult(body: unknown): SpeakingV2TestResult {
  const projected = speakingV2Projection(body);
  validateSpeakingV2Result(SpeakingV2TestResultSchema, projected);
  return Value.Parse(SpeakingV2TestResultSchema, projected);
}
