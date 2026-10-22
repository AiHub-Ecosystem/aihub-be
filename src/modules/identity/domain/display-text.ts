/**
 * Characters that change how the text around them is shown instead of adding to
 * it: C0 and C1 controls (line breaks among them), the Unicode line and
 * paragraph separators, and the bidirectional marks, embeddings, overrides and
 * isolates. A name carrying one can start a new line or reverse what follows it
 * wherever it is shown, the subject and body of an invitation email included.
 * Joiners stay allowed, so emoji sequences still work.
 */
const LAYOUT_CONTROL =
  /[\p{Cc}\u00AD\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;

/** Whether an owner-chosen name shows as exactly the characters it holds. */
export function isDisplayText(value: string): boolean {
  return !LAYOUT_CONTROL.test(value);
}
