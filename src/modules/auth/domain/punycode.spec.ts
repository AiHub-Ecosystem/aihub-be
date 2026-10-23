import { decodePunycode } from './punycode';

describe('decodePunycode', () => {
  it.each([
    ['bcher-kva', 'bücher'],
    ['pple-43d', 'аpple'],
    ['mnchen-3ya', 'münchen'],
    ['r8jz45g', '例え'],
    ['e1afmkfd', 'пример'],
    ['hxajbheg2az3al', 'παράδειγμα'],
    ['mgbh0fb', 'مثال'],
    ['v-d-rma6749a', 'ví-dụ'],
  ])('decodes %s to %s', (encoded, label) => {
    expect(decodePunycode(encoded)).toBe(label);
  });

  it.each([
    ['a', 'a bare digit that decodes to a control character'],
    ['-bcher-kva', 'a leading hyphen, which is not a digit'],
    ['Bcher-kva', 'an upper-case letter in the decoded label'],
    ['', 'an empty label'],
    ['bcher-kv', 'a truncated final number'],
    ['bcher-kva!', 'a character outside the digits'],
    ['abc', 'a label with no non-ASCII code point'],
    ['über-abc', 'a non-ASCII character in the basic part'],
  ])('refuses %j, %s', (encoded) => {
    expect(decodePunycode(encoded)).toBeUndefined();
  });
});
