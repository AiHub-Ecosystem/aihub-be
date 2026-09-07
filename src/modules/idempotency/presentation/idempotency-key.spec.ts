import { AppError } from '../../../common/errors/app-error';
import {
  requireIdempotencyKey,
  resolveIdempotencyKey,
} from './idempotency-key';

describe('requireIdempotencyKey', () => {
  it('trims an opaque key and enforces the UTF-8 byte limit', () => {
    expect(requireIdempotencyKey('  grade-123  ')).toBe('grade-123');
    expect(() => requireIdempotencyKey(undefined)).toThrow(AppError);
    expect(() => requireIdempotencyKey('   ')).toThrow(AppError);
    expect(() => requireIdempotencyKey('x'.repeat(256))).toThrow(AppError);
    expect(() => requireIdempotencyKey('é'.repeat(128))).toThrow(AppError);
  });

  it('rejects duplicate header values instead of guessing', () => {
    expect(() => requireIdempotencyKey(['a', 'b'])).toThrow(AppError);
  });

  it('resolves headers according to the operation catalog', () => {
    expect(
      resolveIdempotencyKey('writing.task1.question.generate', ['a', 'b']),
    ).toBeUndefined();
    expect(
      resolveIdempotencyKey('writing.task2.question.generate', undefined),
    ).toBeUndefined();
    expect(
      resolveIdempotencyKey('writing.task2.question.generate', '  question-1 '),
    ).toBe('question-1');
    expect(() =>
      resolveIdempotencyKey('writing.task2.question.generate', ['a', 'b']),
    ).toThrow(AppError);
    expect(() =>
      resolveIdempotencyKey('writing.task1.grade', undefined),
    ).toThrow(AppError);
  });
});
