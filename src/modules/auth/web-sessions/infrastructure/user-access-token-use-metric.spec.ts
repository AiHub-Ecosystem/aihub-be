import { registry } from '@/common/observability/metrics/metrics';

import { recordUserAccessTokenUse } from './user-access-token-use-metric';

async function count(scheme: string, session: string): Promise<number> {
  const text = await registry.metrics();
  const line = text
    .split('\n')
    .find((entry) =>
      entry.startsWith(
        `aihub_user_access_token_use_total{scheme="${scheme}",session="${session}"}`,
      ),
    );
  return line === undefined ? Number.NaN : Number(line.split(' ').at(-1));
}

describe('aihub_user_access_token_use_total', () => {
  it('starts every scheme and session series at zero, so the first Bearer use after a restart is visible', async () => {
    for (const scheme of ['bearer', 'dpop']) {
      for (const session of ['web', 'refresh', 'none']) {
        expect(await count(scheme, session)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('counts one use under exactly its scheme and session', async () => {
    const before = await count('bearer', 'web');
    const otherBefore = await count('dpop', 'web');

    recordUserAccessTokenUse({ scheme: 'bearer', session: 'web' });

    expect(await count('bearer', 'web')).toBe(before + 1);
    expect(await count('dpop', 'web')).toBe(otherBefore);
  });
});
