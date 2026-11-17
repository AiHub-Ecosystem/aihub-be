import { stripControlCharacters } from './model-text';

describe('stripControlCharacters', () => {
  it('drops C0, C1 and bidirectional controls but keeps tab, newline and carriage return', () => {
    expect(
      stripControlCharacters('a\u0000b\u0007c\u001fd\u007fe\u0085f‮g⁧h'),
    ).toBe('abcdefgh');
    expect(stripControlCharacters('line\r\n\tnext')).toBe('line\r\n\tnext');
  });

  it('leaves ordinary text, including Vietnamese and emoji, unchanged', () => {
    const text = 'Bài viết có bố cục rõ ràng 👍 — đạt band 6.5';

    expect(stripControlCharacters(text)).toBe(text);
  });

  it('cleans every string in a nested body and keeps its keys and other values', () => {
    const cleaned = stripControlCharacters({
      'k\u0007ey': ['x\u0007', { deep: 'y\u0000' }],
      band: 6.5,
      done: true,
      nothing: null,
    });

    expect(cleaned).toEqual({
      'k\u0007ey': ['x', { deep: 'y' }],
      band: 6.5,
      done: true,
      nothing: null,
    });
  });
});
