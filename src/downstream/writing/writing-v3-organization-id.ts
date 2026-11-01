import { createHash } from 'node:crypto';

/**
 * AI Writing v3 accepts only a 36-character UUID in `X-AIHUB-Organization-Id`
 * and answers `org_...` with 400 (probed on its Test and Production
 * environments, 2026-11-01; ADR-0143 decision 13). AIHUB therefore sends a
 * UUIDv5 of its Organization ID in this namespace. Never change the namespace:
 * the provider keys each learner's history by the value it receives, so a new
 * namespace starts every learner's `Progress` again.
 */
export const WRITING_V3_ORGANIZATION_NAMESPACE =
  '70a63f65-823c-4ae7-8443-58c2f643a746';

/** RFC 4122 section 4.3 name-based UUID (SHA-1). */
export function uuidV5(name: string, namespace: string): string {
  const digest = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function providerOrganizationId(organizationId: string): string {
  return uuidV5(organizationId, WRITING_V3_ORGANIZATION_NAMESPACE);
}
