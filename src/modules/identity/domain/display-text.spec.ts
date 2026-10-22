import { isDisplayText } from './display-text';

describe('isDisplayText', () => {
  it.each([
    ['a zero width space', '\u200B'],
    ['a soft hyphen', '\u00AD'],
    ['a zero width no-break space', '\uFEFF'],
    ['a word joiner', '\u2060'],
    ['an invisible operator', '\u2061'],
    ['an invisible plus', '\u2062'],
    ['an invisible minus', '\u2063'],
    ['an invisible separator', '\u2064'],
  ])('refuses %s', (_label, character) => {
    expect(isDisplayText(`Acme${character}Ltd`)).toBe(false);
  });

  it('keeps the joiners and variation selectors emoji sequences need', () => {
    // The zero width joiner, the non-joiner, and the variation selectors are
    // how one emoji is written; refusing them would break real names.
    expect(isDisplayText('Acme 👨‍👩‍👧')).toBe(true);
    expect(isDisplayText('Acme 👩🏽‍🚀')).toBe(true);
    expect(isDisplayText('Acme \u200CLtd')).toBe(true);
    expect(isDisplayText('Acme ☺️')).toBe(true);
  });
});
