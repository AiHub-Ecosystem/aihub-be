import type { Prisma } from '@prisma-client/client';

/**
 * The credential hashes of every key an Organization holds, whatever its own
 * status: a revoked key's cached record is gone already, so purging it again
 * costs one delete and removes a special case. The caller purges after commit.
 */
export async function organizationKeyHashes(
  transaction: Pick<Prisma.TransactionClient, 'apiKey'>,
  organizationId: string,
): Promise<readonly string[]> {
  const keys = await transaction.apiKey.findMany({
    where: { organizationId },
    select: { keyHash: true },
  });
  return keys.map((key) => Buffer.from(key.keyHash).toString('hex'));
}
