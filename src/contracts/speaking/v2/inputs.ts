import type { Static } from '@sinclair/typebox';

import type { SpeakingAudio } from '@/contracts/speaking/grading';
import type {
  SpeakingV2PartGradeRequestSchema,
  SpeakingV2PartPathSchema,
  SpeakingV2ResponsePathSchema,
  SpeakingV2TestGradeRequestSchema,
  SpeakingV2TestPathSchema,
} from './requests';
import type { SpeakingV2TestType } from './response.shared';

/** The multipart question grade, decoded: the audio plus the declared fields. */
export interface SpeakingV2QuestionGradeInput {
  readonly audio: SpeakingAudio;
  readonly part: number;
  readonly questionId: string;
  readonly promptText?: string;
  readonly testType?: SpeakingV2TestType;
  readonly testCode?: string;
  readonly partResultId?: string;
}

export type SpeakingV2PartGradeInput = Static<
  typeof SpeakingV2PartGradeRequestSchema
>;
export type SpeakingV2TestGradeInput = Static<
  typeof SpeakingV2TestGradeRequestSchema
>;
export type SpeakingV2ResponsePath = Static<
  typeof SpeakingV2ResponsePathSchema
>;
export type SpeakingV2PartPath = Static<typeof SpeakingV2PartPathSchema>;
export type SpeakingV2TestPath = Static<typeof SpeakingV2TestPathSchema>;
