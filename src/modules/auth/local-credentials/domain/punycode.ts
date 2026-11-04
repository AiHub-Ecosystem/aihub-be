const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAX_CODE_POINT = 0x10ffff;

// A label made only of letters, marks and numbers, as IDNA allows a decoded
// label to be. A control or symbol decoded from garbage input fails this.
const LABEL_CHARACTERS = /^[\p{L}\p{M}\p{N}-]+$/u;
const NON_ASCII = /\P{ASCII}/u;

// Names follow RFC 3492 section 6.2: `n` is the next code point, `i` the insert
// position, `k` the digit weight step. A digit is a-z (0-25, either case) or
// 0-9 (26-35).
function digitOf(code: number): number | undefined {
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61;
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  return undefined;
}

function adapt(delta: number, points: number, first: boolean): number {
  let scaled = Math.floor(delta / (first ? DAMP : 2));
  scaled += Math.floor(scaled / points);
  let k = 0;
  while (scaled > ((BASE - T_MIN) * T_MAX) >> 1) {
    scaled = Math.floor(scaled / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * scaled) / (scaled + SKEW));
}

/**
 * Decodes the part of an `xn--` label after its prefix (RFC 3492), or returns
 * `undefined` when it is not a label that Unicode would show: bad digits, a
 * number out of range, a decoded label that is pure ASCII, not NFC, not lower
 * case, or not made of letters, marks and numbers. It exists so that the domain
 * layer can read a punycode label without a runtime module.
 */
export function decodePunycode(encoded: string): string | undefined {
  const basicEnd = encoded.lastIndexOf('-');
  const output: number[] = [];
  for (let index = 0; index < Math.max(basicEnd, 0); index += 1) {
    const code = encoded.charCodeAt(index);
    if (code >= 0x80) return undefined;
    output.push(code);
  }

  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  let position = basicEnd > 0 ? basicEnd + 1 : 0;
  while (position < encoded.length) {
    const previous = i;
    let weight = 1;
    for (let k = BASE; ; k += BASE) {
      if (position >= encoded.length) return undefined;
      const digit = digitOf(encoded.charCodeAt(position));
      position += 1;
      if (digit === undefined) return undefined;
      i += digit * weight;
      if (!Number.isSafeInteger(i)) return undefined;
      const threshold =
        k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < threshold) break;
      weight *= BASE - threshold;
      if (!Number.isSafeInteger(weight)) return undefined;
    }
    const length = output.length + 1;
    bias = adapt(i - previous, length, previous === 0);
    n += Math.floor(i / length);
    i %= length;
    if (n > MAX_CODE_POINT) return undefined;
    output.splice(i, 0, n);
    i += 1;
  }

  const decoded = String.fromCodePoint(...output);
  return NON_ASCII.test(decoded) &&
    LABEL_CHARACTERS.test(decoded) &&
    !decoded.startsWith('-') &&
    !decoded.endsWith('-') &&
    decoded === decoded.normalize('NFC') &&
    decoded === decoded.toLowerCase()
    ? decoded
    : undefined;
}
