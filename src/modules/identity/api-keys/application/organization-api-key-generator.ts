import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import {
  type GeneratedApiKey,
  generateApiKey,
} from '@/modules/identity/domain/api-key';

/** Same-millisecond `ak_` order follows mint order within this process only. */
const nextOrganizationApiKeyId = prefixedIdGenerator('ak_');

export function generateOrganizationApiKey(
  now: Date = new Date(),
): GeneratedApiKey {
  const id = nextOrganizationApiKeyId(now);
  return generateApiKey(id);
}
