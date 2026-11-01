import { WRITING_V2_ESSAY_MAX_WORDS } from '@/contracts/writing/v2/grading';
import { isWithinEssayWordLimit } from './essay-word-limit.policy';

const words = (count: number, separator = ' '): string =>
  Array.from({ length: count }, (_, index) => `w${index}`).join(separator);

describe('isWithinEssayWordLimit', () => {
  it('accepts exactly the limit and refuses one word more', () => {
    expect(WRITING_V2_ESSAY_MAX_WORDS).toBe(1_000);
    expect(isWithinEssayWordLimit(words(1_000))).toBe(true);
    expect(isWithinEssayWordLimit(words(1_001))).toBe(false);
  });

  it('counts runs of non-whitespace, whatever the whitespace is', () => {
    expect(isWithinEssayWordLimit(words(1_000, '\n\n'))).toBe(true);
    expect(isWithinEssayWordLimit(words(1_001, '\t'))).toBe(false);
    expect(isWithinEssayWordLimit(`  ${words(1_000)}  \n`)).toBe(true);
  });

  it('does not count punctuation joined to a word as another word', () => {
    expect(isWithinEssayWordLimit(words(1_000, ', '))).toBe(true);
  });
});
