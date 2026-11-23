import {
  downstreamUrlAttributes,
  postgresOperationName,
  redisOperationName,
} from './span-sanitizers';

describe('span sanitizers', () => {
  it('keeps only the SQL operation and drops query content', () => {
    expect(
      postgresOperationName(" SELECT * FROM api_keys WHERE hash = 'sensitive'"),
    ).toBe('SELECT');
    expect(postgresOperationName('/* query comment */ SELECT 1')).toBe('QUERY');
  });

  it('normalizes the Redis command without retaining keys or arguments', () => {
    expect(redisOperationName('evalsha')).toBe('EVALSHA');
  });

  it('removes downstream URL credentials and query values', () => {
    expect(
      downstreamUrlAttributes(
        'https://user:password@example.test',
        '/grade?token=secret',
      ),
    ).toEqual({
      'url.full': 'https://example.test/grade',
      'url.query': '',
    });
  });
});
