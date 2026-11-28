import { isSafeObjectKey } from './safe-object-key';

describe('isSafeObjectKey', () => {
  it('accepts a bounded key without traversal or reserved characters', () => {
    expect(isSafeObjectKey('users/usr_01J/original/ava_01J.webp')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['longer than 1024 characters', `users/${'a'.repeat(1_025)}`],
    ['traversal', 'users/../secret'],
    ['space', 'users/a b/avatar'],
    ['tab', 'users/a\tb/avatar'],
    ['newline', 'users/a\nb/avatar'],
    ['query', 'users/x?y'],
    ['fragment', 'users/x#y'],
  ])('refuses a key that is %s', (_reason, objectKey) => {
    expect(isSafeObjectKey(objectKey)).toBe(false);
  });

  it('accepts exactly 1024 characters', () => {
    expect(isSafeObjectKey(`users/${'a'.repeat(1_018)}`)).toBe(true);
  });
});
