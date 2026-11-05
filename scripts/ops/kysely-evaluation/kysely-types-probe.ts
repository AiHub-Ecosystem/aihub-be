import type { DB } from '@kysely-types/types';
import { Kysely, PostgresDialect } from 'kysely';

declare const pool: ConstructorParameters<typeof PostgresDialect>[0]['pool'];
const database = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

export async function probe(): Promise<void> {
  await database
    .selectFrom('usage_records')
    .select(['request_id', 'organization_id', 'created_at'])
    .where('billable_requests', '=', 1)
    .execute();
  await database.destroy();
}
