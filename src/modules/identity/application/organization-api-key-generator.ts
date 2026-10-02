import { monotonicFactory } from 'ulid';

import {
  type GeneratedApiKey,
  generateApiKey,
} from '@/modules/identity/domain/api-key';

/** Same-millisecond `ak_` order follows mint order within this process only. */
const nextOrganizationApiKeyId = monotonicFactory();

export function generateOrganizationApiKey(
  now: Date = new Date(),
): GeneratedApiKey {
  const id = `ak_${nextOrganizationApiKeyId(now.getTime())}`;
  return generateApiKey(id);
}
