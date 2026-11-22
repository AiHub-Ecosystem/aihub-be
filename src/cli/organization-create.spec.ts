import type {
  CreateOrganizationInput,
  CreateOrganizationResult,
  OrganizationCreatePort,
} from '@/modules/identity/organizations/application/organization-create.port';
import {
  type CreateOrganizationCliInput,
  runCreateOrganizationCommand,
} from './organization-create';

class OrganizationCreateFake implements OrganizationCreatePort {
  readonly calls: CreateOrganizationInput[] = [];
  closed = false;

  constructor(
    private readonly result: CreateOrganizationResult = {
      kind: 'created',
      id: 'org_fake_01',
    },
  ) {}

  async createOrganization(
    input: CreateOrganizationInput,
  ): Promise<CreateOrganizationResult> {
    this.calls.push(input);
    return { ...this.result, id: input.id };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function run(
  overrides: Partial<CreateOrganizationCliInput> = {},
  result?: CreateOrganizationResult,
) {
  const repository = new OrganizationCreateFake(result);
  const printed: string[] = [];
  const lines: string[] = [];
  const outcome = runCreateOrganizationCommand({
    databaseUrl: 'postgres://unused',
    name: 'Acme Corp',
    repository,
    print: (line) => printed.push(line),
    emit: (line) => lines.push(line),
    now: () => new Date('2026-10-28T10:00:00.000Z'),
    ...overrides,
  });
  return { outcome, repository, printed, lines };
}

describe('runCreateOrganizationCommand', () => {
  it('creates an organization with default terms and prints its id', async () => {
    const { outcome, repository, printed } = run({
      organizationId: 'org_custom_123',
    });

    await expect(outcome).resolves.toBe('created');
    expect(repository.calls).toEqual([
      {
        id: 'org_custom_123',
        name: 'Acme Corp',
        entitlements: ['writing'],
        rateLimitRpm: 600,
        maxConcurrent: 20,
        monthlyRequestQuota: null,
        hardStopOnQuota: false,
      },
    ]);
    expect(printed).toEqual(['org_custom_123']);
    expect(repository.closed).toBe(true);
  });

  it('creates an organization with custom options and auto-generates ulid if omitted', async () => {
    const { outcome, repository, printed } = run({
      name: 'Custom Edu',
      entitlements: ['writing', 'speaking'],
      rateLimitRpm: 1200,
      maxConcurrent: 40,
      monthlyRequestQuota: 10_000,
      hardStopOnQuota: true,
    });

    await expect(outcome).resolves.toBe('created');
    const [call] = repository.calls;
    expect(call?.id).toMatch(/^org_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(call).toMatchObject({
      name: 'Custom Edu',
      entitlements: ['writing', 'speaking'],
      rateLimitRpm: 1200,
      maxConcurrent: 40,
      monthlyRequestQuota: 10_000,
      hardStopOnQuota: true,
    });
    expect(printed).toEqual([call?.id]);
    expect(repository.closed).toBe(true);
  });

  it('closes repository even when creation fails', async () => {
    const repository = new OrganizationCreateFake();
    repository.createOrganization = async () => {
      throw new Error('db failure');
    };

    await expect(
      runCreateOrganizationCommand({
        databaseUrl: 'postgres://unused',
        name: 'Fail Corp',
        repository,
      }),
    ).rejects.toThrow('db failure');

    expect(repository.closed).toBe(true);
  });
});
