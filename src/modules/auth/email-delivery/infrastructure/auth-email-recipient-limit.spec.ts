import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';
import { assertRetainedKeyVersionsCoverLiveWindows } from './auth-email-recipient-limit';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const KEY = Buffer.alloc(32, 7).toString('base64');

function keyring(...versions: string[]): EmailOutboxRuntimeSecrets {
  const current = versions[versions.length - 1];
  if (current === undefined) throw new Error('a keyring needs a version');
  return {
    currentKeyId: current,
    keys: Object.fromEntries(versions.map((version) => [version, KEY])),
  };
}

describe('assertRetainedKeyVersionsCoverLiveWindows', () => {
  it('refuses when a live window sits under a version the keyring dropped', async () => {
    const script = new ScriptedPrisma();
    script.outside = [
      [
        {
          key_version: 'v1',
          expires_at: new Date('2026-10-25T00:00:00.000Z'),
        },
      ],
    ];

    await expect(
      assertRetainedKeyVersionsCoverLiveWindows(
        script.client(),
        keyring('v2'),
        NOW,
      ),
    ).rejects.toThrow(
      /no longer retains key versions with live authentication-email recipient windows: v1 \(windows live until 2026-10-25T00:00:00.000Z\)/,
    );
  });

  it('passes when every live window fingerprints under a retained version', async () => {
    const script = new ScriptedPrisma();
    script.outside = [
      [
        { key_version: 'v1', expires_at: new Date('2026-10-25T00:00:00.000Z') },
        { key_version: 'v2', expires_at: new Date('2026-10-25T06:00:00.000Z') },
      ],
    ];

    await expect(
      assertRetainedKeyVersionsCoverLiveWindows(
        script.client(),
        keyring('v1', 'v2'),
        NOW,
      ),
    ).resolves.toBeUndefined();
  });

  it('passes when no window is live, whatever the keyring retains', async () => {
    const script = new ScriptedPrisma();

    await expect(
      assertRetainedKeyVersionsCoverLiveWindows(
        script.client(),
        undefined,
        NOW,
      ),
    ).resolves.toBeUndefined();
  });
});
