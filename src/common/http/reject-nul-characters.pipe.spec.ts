import { AppError } from '@/common/errors/app-error';
import { RejectNulCharactersPipe } from './reject-nul-characters.pipe';

describe('RejectNulCharactersPipe', () => {
  const pipe = new RejectNulCharactersPipe();

  it.each([
    ['param', 'org_\u0000acme'],
    ['query', { cursor: 'x\u0000' }],
  ] as const)('refuses a NUL character in a %s value', (type, value) => {
    expect(() => pipe.transform(value, { type })).toThrow(AppError);
  });

  it('passes ordinary path and query values through unchanged', () => {
    expect(pipe.transform('org_acme', { type: 'param' })).toBe('org_acme');
    const query = { limit: '20' };
    expect(pipe.transform(query, { type: 'query' })).toBe(query);
  });

  it('leaves bodies to parseRequestBody', () => {
    const body = { name: 'a\u0000b' };
    expect(pipe.transform(body, { type: 'body' })).toBe(body);
  });
});
