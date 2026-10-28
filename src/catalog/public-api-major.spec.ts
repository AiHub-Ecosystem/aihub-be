import { publicApiMajorOf } from './public-api-major';

describe('publicApiMajorOf', () => {
  it('reads the major from the first path segment of a matched route', () => {
    expect(publicApiMajorOf('/v1/ielts/writing/task1/grade')).toBe(1);
    expect(publicApiMajorOf('/v2/organizations/:organizationId')).toBe(2);
    expect(publicApiMajorOf('/v12/whoami')).toBe(12);
  });

  it('is undefined for routes outside the versioned Public API', () => {
    expect(publicApiMajorOf('/health')).toBeUndefined();
    expect(publicApiMajorOf('/metrics')).toBeUndefined();
    expect(publicApiMajorOf('/docs')).toBeUndefined();
    expect(publicApiMajorOf('/openapi/v1.json')).toBeUndefined();
    expect(publicApiMajorOf('unmatched')).toBeUndefined();
    expect(publicApiMajorOf('/v1')).toBeUndefined();
    expect(publicApiMajorOf('/v0/x')).toBeUndefined();
    expect(publicApiMajorOf('/v01/x')).toBeUndefined();
    expect(publicApiMajorOf('/version/x')).toBeUndefined();
  });
});
