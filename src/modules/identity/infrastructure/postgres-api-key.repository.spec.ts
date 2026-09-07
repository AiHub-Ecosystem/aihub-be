import { AppError } from '../../../common/errors/app-error';
import {
  PostgresApiKeyRepository,
  type PostgresIdentityClient,
} from './postgres-api-key.repository';

const row = {
  organization_id: 'org_acme',
  api_key_id: 'ak_backend',
  organization_status: 'active',
  api_key_status: 'active',
  scopes: ['writing.question.generate'],
  entitlements: ['writing'],
  allowed_environments: ['development', 'production'],
  expires_at: null,
  rate_limit_rpm: 600,
  max_concurrent: 20,
  monthly_request_quota: null,
  hard_stop_on_quota: false,
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

describe('PostgresApiKeyRepository', () => {
  it('looks up a key hash with a parameterized bytea query and maps organization policy', async () => {
    const client = new FakePostgres();
    const repository = new PostgresApiKeyRepository(client);

    await expect(repository.findByHash('ab'.repeat(32))).resolves.toEqual({
      organizationId: 'org_acme',
      apiKeyId: 'ak_backend',
      organizationStatus: 'active',
      status: 'active',
      scopes: ['writing.question.generate'],
      entitlements: ['writing'],
      allowedEnvironments: ['development', 'production'],
      expiresAt: null,
      rateLimitRpm: 600,
      maxConcurrent: 20,
      monthlyRequestQuota: null,
      hardStopOnQuota: false,
    });

    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]?.values).toEqual(['ab'.repeat(32)]);
    expect(client.queries[0]?.text).toContain("decode($1, 'hex')");
  });

  it('returns null for a missing durable key record', async () => {
    const client = new FakePostgres();
    client.result = [];

    await expect(
      new PostgresApiKeyRepository(client).findByHash('ab'.repeat(32)),
    ).resolves.toBeNull();
  });

  it('rejects malformed control-plane data without leaking the row', async () => {
    const client = new FakePostgres();
    client.result = [{ ...row, scopes: ['writing.question.generate', 7] }];

    const error = await new PostgresApiKeyRepository(client)
      .findByHash('ab'.repeat(32))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INTERNAL_ERROR');
    expect((error as AppError).message).toBe('Identity data is invalid');
  });
});
