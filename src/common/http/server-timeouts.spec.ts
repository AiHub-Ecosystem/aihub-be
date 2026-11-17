import { CONNECTION_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from './server-timeouts';

describe('server timeouts', () => {
  it('uses the catalog maximum deadline and upload time at 500 bytes/s', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(54_650_952);
  });

  it('bounds an idle connection and never disables either timeout', () => {
    expect(CONNECTION_TIMEOUT_MS).toBe(60_000);
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(CONNECTION_TIMEOUT_MS);
  });
});
