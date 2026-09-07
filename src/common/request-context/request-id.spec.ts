import {
  REQUEST_ID_PREFIX,
  generateRequestId,
  isRequestId,
} from './request-id';

describe('request id', () => {
  it('produces a prefixed 26-character ULID', () => {
    const id = generateRequestId();

    expect(id).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id.startsWith(REQUEST_ID_PREFIX)).toBe(true);
  });

  it('stays sortable for ids minted in the same millisecond', () => {
    const ids = Array.from({ length: 50 }, () => generateRequestId());

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects ids that do not match the contract', () => {
    expect(isRequestId(generateRequestId())).toBe(true);
    // Fastify's default counter, i.e. the shape before genReqId was set.
    expect(isRequestId('req-1')).toBe(false);
    expect(isRequestId('1')).toBe(false);
    expect(isRequestId('01JXYZ')).toBe(false);
    expect(isRequestId(undefined)).toBe(false);
  });
});
