import { createHash } from 'node:crypto';
import type { PublicJsonWebKey } from '@/modules/identity/domain/organization-identity-config';

/**
 * RFC 7638 thumbprint of a public JWK: SHA-256 over the key's required
 * members only, in lexicographic member order with no whitespace, encoded
 * base64url without padding. The audit trail uses it to record which public
 * keys a configuration trusted without storing the keys themselves (#447).
 * Returns undefined for a key the supported algorithms cannot thumbprint.
 */
export function jsonWebKeyThumbprint(
  jwk: PublicJsonWebKey,
): string | undefined {
  const kty = jwk.kty;
  if (typeof kty !== 'string') return undefined;

  // RFC 7638 hashes the members' values exactly as the JWK carries them, so
  // the base64url strings go into the canonical JSON unreencoded.
  let required: Record<string, string>;
  if (kty === 'RSA') {
    const e = jwk.e;
    const n = jwk.n;
    if (typeof e !== 'string' || typeof n !== 'string') return undefined;
    required = { e, kty, n };
  } else if (kty === 'EC') {
    const crv = jwk.crv;
    const x = jwk.x;
    const y = jwk.y;
    if (
      typeof crv !== 'string' ||
      typeof x !== 'string' ||
      typeof y !== 'string'
    ) {
      return undefined;
    }
    required = { crv, kty, x, y };
  } else {
    return undefined;
  }

  // Property insertion order is the lexicographic RFC order for both key
  // types, so plain stringify needs no replacer.
  const canonical = JSON.stringify(required);
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}
