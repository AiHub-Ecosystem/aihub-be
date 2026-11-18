import { createHmac } from 'node:crypto';

import { isRecord } from '@/common/is-record';
import { constantTimeEquals } from '@/common/security/constant-time-equals';
import { canonicalJson } from '@/common/serialization/canonical-json';

export type IdentityCacheKind = 'api_key' | 'jwks';

export type IdentityCacheVerificationResult =
  | { readonly authenticated: true; readonly data: unknown }
  | { readonly authenticated: false };

const ENVELOPE_VERSION = 1;

function authenticatedInput(
  kind: IdentityCacheKind,
  redisKey: string,
  data: unknown,
): string {
  return canonicalJson({ version: ENVELOPE_VERSION, kind, redisKey, data });
}

function identityCacheEnvelope(
  key: Buffer,
  kind: IdentityCacheKind,
  redisKey: string,
  data: unknown,
): string {
  const mac = createHmac('sha256', key)
    .update(authenticatedInput(kind, redisKey, data))
    .digest('base64url');
  return JSON.stringify({ version: ENVELOPE_VERSION, kind, data, mac });
}

function parseEnvelope(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    return undefined;
  }
}

function containsOwnProtoKey(value: unknown): boolean {
  if (!Array.isArray(value) && !isRecord(value)) return false;
  return (
    Object.hasOwn(value, '__proto__') ||
    Object.values(value).some(containsOwnProtoKey)
  );
}

export function signIdentityCacheEntry(
  key: Buffer,
  kind: IdentityCacheKind,
  redisKey: string,
  data: unknown,
): string {
  return identityCacheEnvelope(key, kind, redisKey, data);
}

export function verifyIdentityCacheEntry(input: {
  readonly key: Buffer;
  readonly kind: IdentityCacheKind;
  readonly redisKey: string;
  readonly serialized: string;
}): IdentityCacheVerificationResult {
  const envelope: unknown = parseEnvelope(input.serialized);
  if (!isRecord(envelope)) {
    return { authenticated: false };
  }

  if (
    envelope['version'] !== ENVELOPE_VERSION ||
    envelope['kind'] !== input.kind ||
    typeof envelope['mac'] !== 'string'
  ) {
    return { authenticated: false };
  }

  let macInput: string;
  try {
    if (containsOwnProtoKey(envelope['data'])) return { authenticated: false };
    macInput = authenticatedInput(input.kind, input.redisKey, envelope['data']);
  } catch {
    return { authenticated: false };
  }
  const expected = createHmac('sha256', input.key)
    .update(macInput)
    .digest('base64url');
  if (!constantTimeEquals(envelope['mac'], expected)) {
    return { authenticated: false };
  }
  return { authenticated: true, data: envelope['data'] };
}
