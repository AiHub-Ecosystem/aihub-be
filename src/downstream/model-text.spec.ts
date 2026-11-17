import { AppError } from '@/common/errors/app-error';
import {
  MAX_RESPONSE_DEPTH,
  assertTextWithinLimit,
  stripControlCharacters,
} from './model-text';

const RLO = String.fromCodePoint(0x202e);
const RLI = String.fromCodePoint(0x2067);

function nested(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < depth; level += 1) value = [value];
  return value;
}

describe('stripControlCharacters', () => {
  it('drops C0, C1 and bidirectional controls but keeps tab, newline and carriage return', () => {
    expect(
      stripControlCharacters(
        'a\u0000b\u0007c\u001fd\u007fe\u0085f' + RLO + 'g' + RLI + 'h',
      ),
    ).toBe('abcdefgh');
    expect(stripControlCharacters('line\r\n\tnext')).toBe('line\r\n\tnext');
  });

  it('leaves ordinary text, including Vietnamese and emoji, unchanged', () => {
    const text = 'Bài viết có bố cục rõ ràng 👍 — đạt band 6.5';

    expect(stripControlCharacters(text)).toBe(text);
  });

  it('cleans every string and every key in a nested body and keeps other values', () => {
    const cleaned = stripControlCharacters({
      'k\u0007ey': ['x\u0007', { ['in' + RLO + 'ner']: 'y\u0000' }],
      band: 6.5,
      done: true,
      nothing: null,
    });

    expect(cleaned).toEqual({
      key: ['x', { inner: 'y' }],
      band: 6.5,
      done: true,
      nothing: null,
    });
  });

  it('accepts a body nested exactly to the depth limit', () => {
    expect(() =>
      stripControlCharacters(nested(MAX_RESPONSE_DEPTH)),
    ).not.toThrow();
  });

  it('refuses a deeper body as a contract violation instead of exhausting the stack', () => {
    let thrown: unknown;
    try {
      stripControlCharacters(nested(10_000));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ code: 'AI_SERVICE_CONTRACT_VIOLATION' });
  });
});

describe('assertTextWithinLimit', () => {
  it('accepts text up to the limit at any depth, and ignores keys and non-strings', () => {
    expect(() =>
      assertTextWithinLimit(
        { ['k'.repeat(50)]: ['x'.repeat(10), { deep: 'y'.repeat(10) }], n: 99 },
        10,
      ),
    ).not.toThrow();
  });

  it('refuses a longer string as a contract violation that does not echo it', () => {
    let thrown: unknown;
    try {
      assertTextWithinLimit({ list: ['ok', 'secret'.repeat(5)] }, 10);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ code: 'AI_SERVICE_CONTRACT_VIOLATION' });
    const logged =
      thrown instanceof AppError
        ? `${thrown.message} ${thrown.diagnostic}`
        : '';
    expect(logged).not.toContain('secret');
  });
});

describe('stripControlCharacters key collisions', () => {
  it('refuses keys that become the same key once cleaned, rather than dropping one', () => {
    let thrown: unknown;
    try {
      stripControlCharacters({ AB: 1, 'A\u0007B': 2 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ code: 'AI_SERVICE_CONTRACT_VIOLATION' });
  });

  it('keeps distinct keys that stay distinct once cleaned', () => {
    expect(stripControlCharacters({ AB: 1, 'A\u0007C': 2 })).toEqual({
      AB: 1,
      AC: 2,
    });
  });
});
