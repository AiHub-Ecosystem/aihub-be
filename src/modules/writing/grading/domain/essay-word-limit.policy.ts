import { WRITING_V2_ESSAY_MAX_WORDS } from '@/contracts/writing/v2/grading';

/**
 * AI Writing v3 refuses an essay of more than 1000 words with a 413, but only
 * after the caller has waited. AIHUB refuses it first (ADR-0143 decision 11).
 * A word is a run of non-whitespace characters; the schema already caps the
 * essay at 20 000 code units, so building the match list is cheap.
 */
export function isWithinEssayWordLimit(essay: string): boolean {
  return (essay.match(/\S+/g) ?? []).length <= WRITING_V2_ESSAY_MAX_WORDS;
}
