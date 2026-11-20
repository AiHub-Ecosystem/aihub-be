import {
  REGISTRATION_ATTEMPT_PURPOSE,
  fingerprintAddresses,
} from '@/modules/auth/shared/infrastructure/address-window-counter';
import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';
import { countRegistrationAttempt } from './postgres-registration-attempt-counter';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const EMAIL = 'person@example.com';
const KEY = Buffer.alloc(32, 7).toString('base64');

function keyring(...versions: string[]): EmailOutboxRuntimeSecrets {
  const currentKeyId = versions.at(-1);
  if (currentKeyId === undefined) throw new Error('a keyring needs a version');
  return {
    currentKeyId,
    keys: Object.fromEntries(versions.map((version) => [version, KEY])),
  };
}

describe('countRegistrationAttempt', () => {
  it('counts a normalized address in a durable transaction without storing it', async () => {
    const script = new ScriptedPrisma();

    await countRegistrationAttempt(script.client(), keyring('v1'), {
      email: EMAIL,
      now: NOW,
    });

    const insert = script.statements.find(({ name }) =>
      name.includes('INSERT INTO auth_registration_attempt_counters'),
    );
    expect(insert?.args).toEqual([
      'v1',
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      NOW,
      new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    ]);
    expect(JSON.stringify(insert?.args)).not.toContain(EMAIL);
  });

  it('continues an active window under its original key during rotation', async () => {
    const secrets = keyring('v1', 'v2');
    const oldFingerprint = fingerprintAddresses(
      EMAIL,
      secrets,
      REGISTRATION_ATTEMPT_PURPOSE,
    ).find(({ keyVersion }) => keyVersion === 'v1');
    if (oldFingerprint === undefined)
      throw new Error('old key was not retained');
    const script = new ScriptedPrisma();
    script.inside = [
      undefined,
      undefined,
      [
        {
          key_version: 'v1',
          address_hmac: oldFingerprint.addressHmac,
          expires_at: new Date('2026-11-21T08:00:00.000Z'),
        },
      ],
    ];

    await countRegistrationAttempt(script.client(), secrets, {
      email: EMAIL,
      now: NOW,
    });

    const update = script.statements.find(({ name }) =>
      name.includes('UPDATE auth_registration_attempt_counters'),
    );
    expect(update?.args).toEqual(['v1', oldFingerprint.addressHmac]);
    expect(update?.name).toContain('SET attempt_count = attempt_count + 1');
  });
});
