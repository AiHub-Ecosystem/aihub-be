// The scripts a label is compared across. Anything else counts as one more
// script ('other'), so two unlisted scripts in one label are not told apart.
const SCRIPTS: readonly (readonly [string, RegExp])[] = [
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['han', /\p{Script=Han}/u],
  ['hiragana', /\p{Script=Hiragana}/u],
  ['katakana', /\p{Script=Katakana}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['thai', /\p{Script=Thai}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
];
const SHARED_SCRIPT = /[\p{Script=Common}\p{Script=Inherited}]/u;
const MARK = /\p{M}/u;
// Scripts whose letters all exist in precomposed form, so a mark left after NFC
// is an overlay (a slash through an o) and not part of a letter.
const PRECOMPOSED = new Set(['latin', 'cyrillic', 'greek']);
// Scripts that are written together in one language.
const JAPANESE = new Set(['han', 'hiragana', 'katakana']);
const KOREAN = new Set(['han', 'hangul']);

function scriptsOf(label: string): string[] {
  const scripts = new Set<string>();
  for (const character of label) {
    if (SHARED_SCRIPT.test(character)) continue;
    scripts.add(
      SCRIPTS.find(([, pattern]) => pattern.test(character))?.[0] ?? 'other',
    );
  }
  return [...scripts];
}

/**
 * Whether a domain label (NFC, lower case) reads as the writing of one language:
 * one script, or Han with kana, or Han with Hangul. A Cyrillic `а` among Latin
 * letters fails it, and so does a leftover combining mark in a script that has
 * precomposed letters. Digits, hyphens and plain combining marks belong to no
 * script of their own.
 */
export function hasOneWritingSystem(label: string): boolean {
  const scripts = scriptsOf(label);
  const mixed =
    scripts.length > 1 &&
    !scripts.every((script) => JAPANESE.has(script)) &&
    !scripts.every((script) => KOREAN.has(script));
  const overlay =
    scripts.some((script) => PRECOMPOSED.has(script)) && MARK.test(label);
  return !mixed && !overlay;
}
