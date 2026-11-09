import cacheArgs from './knip-cache-args.cjs';

describe('knip cache arguments', () => {
  it('enables the knip cache outside CI', () => {
    expect(cacheArgs.knipCacheArgs({})).toEqual(['--cache']);
  });

  it('disables the knip cache on CI runners, which never reuse it', () => {
    expect(cacheArgs.knipCacheArgs({ CI: 'true' })).toEqual([]);
  });

  it('treats any non-empty CI value as CI, never risking a stale cache there', () => {
    expect(cacheArgs.knipCacheArgs({ CI: '1' })).toEqual([]);
    expect(cacheArgs.knipCacheArgs({ CI: 'false' })).toEqual([]);
  });
});
