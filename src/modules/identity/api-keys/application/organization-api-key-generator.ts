import { createHash, randomBytes } from 'node:crypto';
import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import {
  type GeneratedApiKey,
  apiKeyDisplayPrefix,
  apiKeyPrefixForEnvironment,
} from '@/modules/identity/domain/api-key';

const nextOrganizationApiKeyId = prefixedIdGenerator('ak_');

const API_KEY_SECRET_LENGTH = 43;
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function hashApiKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The one encoder of an API key: 32 random bytes as a zero-padded base62
 * secret, the environment prefix, the hash and the display prefix. Both key
 * families call it, so a change to entropy or format reaches both.
 */
function mintApiKey(id: string, environment?: string): GeneratedApiKey {
  let value = BigInt(`0x${randomBytes(32).toString('hex')}`);
  let secret = '';
  while (value > 0n) {
    const character = BASE62[Number(value % 62n)];
    if (character === undefined) {
      throw new Error('API key alphabet is misconfigured');
    }
    secret = character + secret;
    value /= 62n;
  }

  const raw = `${apiKeyPrefixForEnvironment(environment)}${secret.padStart(
    API_KEY_SECRET_LENGTH,
    '0',
  )}`;
  return {
    id,
    raw,
    hash: hashApiKey(raw),
    prefix: apiKeyDisplayPrefix(raw),
  };
}

export function generateApiKey(
  id: string,
  environment?: string,
): GeneratedApiKey {
  return mintApiKey(id, environment);
}

/** Same-millisecond `ak_` order follows mint order within this process only. */
export function generateOrganizationApiKey(
  now: Date = new Date(),
  environment?: string,
): GeneratedApiKey {
  return mintApiKey(nextOrganizationApiKeyId(now), environment);
}
