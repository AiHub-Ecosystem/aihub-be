import { hasOneWritingSystem } from './script-mix';

describe('hasOneWritingSystem', () => {
  it.each([
    ['a Latin label', 'example'],
    ['a Latin label with digits and a hyphen', 'ex-ample-2'],
    ['a Latin label with precomposed accents', 'bücher'],
    ['a Vietnamese label', 'ví-dụ'],
    ['a Cyrillic label', 'пример'],
    ['a Greek label', 'παράδειγμα'],
    ['a Japanese label of Han and kana', '例え'],
    ['a Korean label of Han and Hangul', '한국어漢'],
    ['an Arabic label with marks', 'مثال'],
    ['a Devanagari label with marks', 'उदाहरण'],
  ])('accepts %s', (_name, label) => {
    expect(hasOneWritingSystem(label)).toBe(true);
  });

  it.each([
    ['a Cyrillic letter among Latin letters', 'аpple'],
    ['a Greek letter among Latin letters', 'exαmple'],
    ['a Latin letter among Han characters', '例a'],
    ['Hangul with kana', '한ひ'],
    ['a slash left over a Latin letter', 'co̸m'],
  ])('refuses %s', (_name, label) => {
    expect(hasOneWritingSystem(label)).toBe(false);
  });
});
