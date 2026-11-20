import { type StringOptions, type TString, Type } from '@sinclair/typebox';

/**
 * Longest feedback, explanation or label an AI Service may put into a public
 * result. The longest such text in the captured Writing responses is 982 code
 * units (`test/fixtures/ai-writing/README.md`), so 4,000 leaves four times that
 * room while keeping one response from carrying an essay-sized paragraph (#377).
 */
export const MODEL_TEXT_MAX_LENGTH = 4_000;

/**
 * Longest passage a result may quote or transcribe. A quote comes from the
 * essay, which AIHUB refuses past 20,000 code units, and a transcript is
 * bounded by the same budget, so no honest passage is longer than this.
 */
export const MODEL_QUOTE_MAX_LENGTH = 20_000;

const UNTRUSTED_NOTE =
  'Model-generated plain text. Treat it as untrusted: render it as text, never as HTML. Control characters are removed. The limit counts UTF-16 code units.';

function modelText(maxLength: number, options: StringOptions): TString {
  return Type.String({
    description: UNTRUSTED_NOTE,
    ...options,
    maxLength,
  });
}

/** A model-generated feedback sentence, explanation or label. */
export function ModelText(options: StringOptions = {}): TString {
  return modelText(MODEL_TEXT_MAX_LENGTH, options);
}

/** A model-generated quotation or transcript: text that comes from the learner. */
export function ModelQuote(options: StringOptions = {}): TString {
  return modelText(MODEL_QUOTE_MAX_LENGTH, options);
}
