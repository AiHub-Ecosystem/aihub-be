import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  identityDrizzleSchema,
  organizations,
} from './drizzle-identity-schema';

describe('identity Drizzle schema', () => {
  it('models the organization creator foreign key without registering user accounts', () => {
    const creatorForeignKey = getTableConfig(organizations).foreignKeys.find(
      (foreignKey) =>
        foreignKey
          .reference()
          .columns.some(
            (column) => column.name === 'created_by_user_account_id',
          ),
    );

    expect(creatorForeignKey).toBeDefined();
    if (!creatorForeignKey) return;

    const reference = creatorForeignKey.reference();
    expect(getTableName(reference.foreignTable)).toBe('user_accounts');
    expect(reference.foreignColumns.map((column) => column.name)).toEqual([
      'id',
    ]);
    expect(creatorForeignKey.onDelete).toBe('restrict');
    expect(Object.keys(identityDrizzleSchema)).toEqual([
      'organizations',
      'apiKeys',
      'organizationIdentityConfigs',
    ]);
  });
});
