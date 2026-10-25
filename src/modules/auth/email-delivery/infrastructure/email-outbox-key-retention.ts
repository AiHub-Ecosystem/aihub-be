import {
  type AuthSqlClient,
  authQueryRows,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

export async function missingQueuedEmailPayloadKeyVersions(
  client: AuthSqlClient,
  secrets: EmailOutboxRuntimeSecrets | undefined,
): Promise<readonly string[]> {
  const rows = await authQueryRows<{ readonly key_version: string }>(
    client,
    `SELECT DISTINCT split_part(payload_ciphertext, '.', 2) AS key_version
     FROM email_delivery_requests
     WHERE status = 'queued'
       AND payload_ciphertext IS NOT NULL
       AND split_part(payload_ciphertext, '.', 1) IN ('v1', 'v2')
       AND split_part(payload_ciphertext, '.', 2) <> ''
     ORDER BY key_version`,
    [],
  );
  const retained = new Set(Object.keys(secrets?.keys ?? {}));
  return rows
    .map(({ key_version }) => key_version)
    .filter((version) => !retained.has(version));
}
