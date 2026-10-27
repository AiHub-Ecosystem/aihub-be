import { numberReply } from './number-reply';

describe('numberReply', () => {
  it('passes an integer reply and refuses anything else', () => {
    expect(numberReply(3)).toBe(3);
    for (const reply of ['3', null, [3], undefined]) {
      expect(() => numberReply(reply)).toThrow(
        'Redis command result is invalid',
      );
    }
  });
});
