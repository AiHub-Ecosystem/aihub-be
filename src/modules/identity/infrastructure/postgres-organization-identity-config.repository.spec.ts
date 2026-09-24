import { AppError } from '../../../common/errors/app-error';
import type { PostgresIdentityClient } from './postgres-api-key.repository';
import { PostgresOrganizationIdentityConfigRepository } from './postgres-organization-identity-config.repository';

const row = {
  organization_id: 'org_acme',
  issuer: 'https://acme.edu',
  jwks_url: 'https://acme.edu/.well-known/jwks.json',
  public_keys_jwks: null,
  allowed_algorithms: ['RS256', 'ES256'],
  max_assertion_ttl_seconds: 300,
  status: 'active',
  updated_at: new Date('2026-09-22T12:34:56.000Z'),
};

class FakePostgres implements PostgresIdentityClient {
  queries: Array<{ text: string; values: readonly unknown[] }> = [];
  result: readonly unknown[] = [row];

  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]> {
    this.queries.push({ text, values });
    return Promise.resolve(this.result);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('PostgresOrganizationIdentityConfigRepository', () => {
  it('loads the active config for the API-key organization', async () => {
    const client = new FakePostgres();

    await expect(
      new PostgresOrganizationIdentityConfigRepository(
        client,
      ).findActiveByOrganizationId('org_acme'),
    ).resolves.toEqual({
      organizationId: 'org_acme',
      issuer: 'https://acme.edu',
      jwksUrl: 'https://acme.edu/.well-known/jwks.json',
      publicKeysJwks: null,
      allowedAlgorithms: ['RS256', 'ES256'],
      maxAssertionTtlSeconds: 300,
      status: 'active',
    });

    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]?.values).toEqual(['org_acme']);
    expect(client.queries[0]?.text).toContain("status = 'active'");
  });

  it('returns null when the organization has no active identity config', async () => {
    const client = new FakePostgres();
    client.result = [];

    await expect(
      new PostgresOrganizationIdentityConfigRepository(
        client,
      ).findActiveByOrganizationId('org_missing'),
    ).resolves.toBeNull();
  });

  it('reads disabled config rows and preserves their update time', async () => {
    const client = new FakePostgres();
    client.result = [{ ...row, status: 'disabled' }];

    await expect(
      new PostgresOrganizationIdentityConfigRepository(
        client,
      ).findByOrganizationId('org_acme'),
    ).resolves.toEqual({
      organizationId: 'org_acme',
      issuer: 'https://acme.edu',
      jwksUrl: 'https://acme.edu/.well-known/jwks.json',
      publicKeysJwks: null,
      allowedAlgorithms: ['RS256', 'ES256'],
      maxAssertionTtlSeconds: 300,
      status: 'disabled',
      updatedAt: new Date('2026-09-22T12:34:56.000Z'),
    });

    expect(client.queries[0]?.values).toEqual(['org_acme']);
    expect(client.queries[0]?.text).not.toContain("status = 'active'");
  });

  it('returns null from the all-status lookup when no row exists', async () => {
    const client = new FakePostgres();
    client.result = [];

    await expect(
      new PostgresOrganizationIdentityConfigRepository(
        client,
      ).findByOrganizationId('org_missing'),
    ).resolves.toBeNull();
  });

  it('rejects stored private JWK members without exposing them', async () => {
    const client = new FakePostgres();
    client.result = [
      {
        ...row,
        public_keys_jwks: {
          keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', d: 'private-material' }],
        },
      },
    ];

    const error = await new PostgresOrganizationIdentityConfigRepository(client)
      .findByOrganizationId('org_acme')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toBe('Identity data is invalid');
    expect(JSON.stringify(error)).not.toContain('private-material');
  });

  it('rejects malformed durable identity data without leaking the row', async () => {
    const client = new FakePostgres();
    client.result = [{ ...row, allowed_algorithms: ['HS256'] }];

    const error = await new PostgresOrganizationIdentityConfigRepository(client)
      .findActiveByOrganizationId('org_acme')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INTERNAL_ERROR');
    expect((error as AppError).message).toBe('Identity data is invalid');
  });
});
