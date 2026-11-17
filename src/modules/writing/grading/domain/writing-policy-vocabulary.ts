/**
 * The vocabulary Writing policy owns. Contracts re-export these through the
 * module's public facade; nothing in domain imports a contract, so the
 * contracts → public → domain edge cannot loop back into domain.
 */

export const CRITERION_IDS = [
  'task_achievement',
  'task_response',
  'coherence_cohesion',
  'lexical_resource',
  'grammatical_range_accuracy',
] as const;

export type CriterionId = (typeof CRITERION_IDS)[number];

export const TASK1_IMAGE_URL_MAX_LENGTH = 2_000;
export const WRITING_EXERCISE_IMAGE_URL_MAX_LENGTH = 2_048;

/**
 * The longest essay AI Writing v3 grades. The provider answers 413 for a longer
 * one only after the caller has waited, so AIHUB refuses it first (ADR-0143
 * decision 11). Words are runs of non-whitespace characters.
 */
export const WRITING_V2_ESSAY_MAX_WORDS = 1_000;

/** The fields an exercise error policy reads; the wire shape derives from a contract. */
export interface WritingExerciseErrorCriterion {
  readonly criterion: CriterionId;
  readonly image_url?: string | null | undefined;
}
