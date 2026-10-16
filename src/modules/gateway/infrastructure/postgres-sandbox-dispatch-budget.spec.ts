import { PostgresSandboxDispatchBudget } from './postgres-sandbox-dispatch-budget';

type BudgetClient = ConstructorParameters<
  typeof PostgresSandboxDispatchBudget
>[0];

const OCTOBER = new Date('2026-10-13T09:00:00.000Z');
const OCTOBER_START = new Date('2026-10-01T00:00:00.000Z');
const NOVEMBER_START = new Date('2026-11-01T00:00:00.000Z');

interface PolicyRow {
  readonly monthStart: Date;
  readonly allowance: number;
}

interface FakePolicy {
  defaults?: readonly PolicyRow[];
  overrides?: readonly (PolicyRow & { readonly organizationId: string })[];
  reservedByOrganization?: Record<string, number>;
  reserved?: number;
  failReads?: boolean;
}

class FakeClient {
  readonly created: { organizationId: string; requestId: string }[] = [];
  readonly released: string[] = [];
  readonly locks: (string | number)[][] = [];
  readonly storedMonthStarts: Date[] = [];

  constructor(private readonly policy: FakePolicy = {}) {}

  async $transaction<T>(work: (tx: FakeClient) => Promise<T>): Promise<T> {
    return work(this);
  }

  async $executeRawUnsafe(...parameters: (string | number)[]): Promise<number> {
    this.locks.push(parameters);
    return 0;
  }

  get sandboxAllowanceOverride() {
    return {
      findUnique: async ({
        where,
      }: {
        where: {
          organizationId_monthStart: {
            organizationId: string;
            monthStart: Date;
          };
        };
      }) => {
        if (this.policy.failReads === true)
          throw new Error('relation unavailable');
        return (
          this.policy.overrides?.find(
            (row) =>
              row.organizationId ===
                where.organizationId_monthStart.organizationId &&
              row.monthStart.getTime() ===
                where.organizationId_monthStart.monthStart.getTime(),
          ) ?? null
        );
      },
    };
  }

  get sandboxAllowanceDefault() {
    return {
      findFirst: async ({
        where,
      }: { where: { monthStart: { lte: Date } } }) => {
        if (this.policy.failReads === true)
          throw new Error('relation unavailable');
        return (
          this.policy.defaults
            ?.filter((row) => row.monthStart <= where.monthStart.lte)
            .sort(
              (a, b) => b.monthStart.getTime() - a.monthStart.getTime(),
            )[0] ?? null
        );
      },
    };
  }

  get sandboxDispatchReservation() {
    const count = async ({
      where,
    }: {
      where: {
        status: string;
        monthStart: Date;
        organizationId?: string;
      };
    }) => {
      if (this.policy.failReads === true)
        throw new Error('connection terminated');
      return where.organizationId === undefined
        ? (this.policy.reserved ?? 0)
        : (this.policy.reservedByOrganization?.[where.organizationId] ?? 0);
    };
    return {
      count,
      create: async ({
        data,
      }: {
        data: { organizationId: string; requestId: string; monthStart: Date };
      }) => {
        if (this.policy.failReads === true)
          throw new Error('connection terminated');
        this.created.push({
          organizationId: data.organizationId,
          requestId: data.requestId,
        });
        this.storedMonthStarts.push(data.monthStart);
        return data;
      },
      updateMany: async ({ where }: { where: { requestId: string } }) => {
        this.released.push(where.requestId);
        return { count: 1 };
      },
    };
  }

  async close(): Promise<void> {}
}

/** The fake implements only the delegates the adapter touches. */
function asBudgetClient(client: FakeClient): BudgetClient {
  return client as unknown as BudgetClient;
}

describe('PostgresSandboxDispatchBudget allowance policy', () => {
  // Two values cross a process boundary here: the `YYYYMM` advisory-lock id,
  // and the `monthStart` date stored on the reservation. Renumbering or
  // shifting either splits one month's reservations across two locks, so both
  // are pinned for a fixed instant.
  it('locks and stores the month the quota period names', async () => {
    const client = new FakeClient({
      defaults: [{ monthStart: OCTOBER_START, allowance: 5 }],
    });

    await new PostgresSandboxDispatchBudget(
      asBudgetClient(client),
      () => OCTOBER,
    ).reserve({ organizationId: 'org_acme', requestId: 'req_1' });

    expect(client.locks).toEqual([
      ['SELECT pg_advisory_xact_lock($1, $2)', 182, 202610],
    ]);
    expect(client.storedMonthStarts).toEqual([OCTOBER_START]);
  });

  it('admits against the persisted default when the Organization has no override', async () => {
    const client = new FakeClient({
      defaults: [{ monthStart: OCTOBER_START, allowance: 5 }],
      reservedByOrganization: { org_acme: 4 },
    });

    await expect(
      new PostgresSandboxDispatchBudget(
        asBudgetClient(client),
        () => OCTOBER,
      ).reserve({
        organizationId: 'org_acme',
        requestId: 'req_1',
      }),
    ).resolves.toBe(true);
    expect(client.created).toEqual([
      { organizationId: 'org_acme', requestId: 'req_1' },
    ]);
  });

  it('refuses the dispatch after the persisted default is consumed', async () => {
    const client = new FakeClient({
      defaults: [{ monthStart: OCTOBER_START, allowance: 5 }],
      reservedByOrganization: { org_acme: 5 },
    });

    await expect(
      new PostgresSandboxDispatchBudget(
        asBudgetClient(client),
        () => OCTOBER,
      ).reserve({
        organizationId: 'org_acme',
        requestId: 'req_1',
      }),
    ).resolves.toBe(false);
    expect(client.created).toEqual([]);
  });

  it('lets a month-specific override replace the default for that month', async () => {
    const client = new FakeClient({
      defaults: [{ monthStart: OCTOBER_START, allowance: 5 }],
      overrides: [
        {
          organizationId: 'org_acme',
          monthStart: OCTOBER_START,
          allowance: 7,
        },
      ],
      reservedByOrganization: { org_acme: 6 },
    });

    await expect(
      new PostgresSandboxDispatchBudget(
        asBudgetClient(client),
        () => OCTOBER,
      ).reserve({
        organizationId: 'org_acme',
        requestId: 'req_1',
      }),
    ).resolves.toBe(true);
  });

  it('treats a zero override as a real allowance, not as missing policy', async () => {
    const client = new FakeClient({
      defaults: [{ monthStart: OCTOBER_START, allowance: 5 }],
      overrides: [
        {
          organizationId: 'org_acme',
          monthStart: OCTOBER_START,
          allowance: 0,
        },
      ],
    });
    const instance = new PostgresSandboxDispatchBudget(
      asBudgetClient(client),
      () => OCTOBER,
    );

    await expect(
      instance.reserve({ organizationId: 'org_acme', requestId: 'req_1' }),
    ).resolves.toBe(false);
    await expect(instance.allowanceFor('org_acme')).resolves.toMatchObject({
      monthlyLimit: 0,
    });
  });

  it('does not carry an override into a month that has none', async () => {
    const client = new FakeClient({
      defaults: [
        { monthStart: OCTOBER_START, allowance: 25 },
        { monthStart: NOVEMBER_START, allowance: 5 },
      ],
      overrides: [
        {
          organizationId: 'org_acme',
          monthStart: OCTOBER_START,
          allowance: 7,
        },
      ],
      reservedByOrganization: { org_acme: 4 },
    });
    const november = new PostgresSandboxDispatchBudget(
      asBudgetClient(client),
      () => new Date('2026-11-02T00:00:00.000Z'),
    );

    await expect(
      november.reserve({ organizationId: 'org_acme', requestId: 'req_2' }),
    ).resolves.toBe(true);
  });

  it('refuses a dispatch rather than admitting one when no default is persisted', async () => {
    const client = new FakeClient({ defaults: [] });

    await expect(
      new PostgresSandboxDispatchBudget(
        asBudgetClient(client),
        () => OCTOBER,
      ).reserve({
        organizationId: 'org_acme',
        requestId: 'req_1',
      }),
    ).rejects.toThrow('Sandbox allowance policy is unavailable');
    expect(client.created).toEqual([]);
  });

  it('refuses a dispatch rather than admitting one when the policy store is unreadable', async () => {
    const client = new FakeClient({
      defaults: [{ monthStart: OCTOBER_START, allowance: 5 }],
      failReads: true,
    });

    // The store's own failure propagates; what matters is that no reservation
    // is written, because the dispatcher turns any throw into a closed door.
    await expect(
      new PostgresSandboxDispatchBudget(
        asBudgetClient(client),
        () => OCTOBER,
      ).reserve({
        organizationId: 'org_acme',
        requestId: 'req_1',
      }),
    ).rejects.toThrow('relation unavailable');
    expect(client.created).toEqual([]);
  });

  it('keeps the shared Sandbox ceiling at 500 regardless of an Organization allowance', async () => {
    const client = new FakeClient({
      defaults: [{ monthStart: OCTOBER_START, allowance: 5 }],
      reserved: 500,
      reservedByOrganization: { org_acme: 0 },
    });

    await expect(
      new PostgresSandboxDispatchBudget(
        asBudgetClient(client),
        () => OCTOBER,
      ).reserve({
        organizationId: 'org_acme',
        requestId: 'req_1',
      }),
    ).resolves.toBe(false);
  });

  it('reports the current allowance snapshot for validation without reserving anything', async () => {
    const client = new FakeClient({
      defaults: [{ monthStart: OCTOBER_START, allowance: 5 }],
      reservedByOrganization: { org_acme: 2 },
      reserved: 490,
    });
    const instance = new PostgresSandboxDispatchBudget(
      asBudgetClient(client),
      () => OCTOBER,
    );

    await expect(instance.allowanceFor('org_acme')).resolves.toEqual({
      monthlyLimit: 5,
      reserved: 2,
      sharedMonthlyLimit: 500,
      sharedReserved: 490,
    });
    expect(client.created).toEqual([]);
  });

  it('reports an exhausted shared Sandbox cap when the Organization still has allowance', async () => {
    const client = new FakeClient({
      defaults: [{ monthStart: OCTOBER_START, allowance: 5 }],
      reservedByOrganization: { org_acme: 0 },
      reserved: 500,
    });
    const instance = new PostgresSandboxDispatchBudget(
      asBudgetClient(client),
      () => OCTOBER,
    );

    await expect(instance.allowanceFor('org_acme')).resolves.toEqual({
      monthlyLimit: 5,
      reserved: 0,
      sharedMonthlyLimit: 500,
      sharedReserved: 500,
    });
  });

  it('reports no allowance rather than a default one when policy state cannot be read', async () => {
    const client = new FakeClient({
      defaults: [{ monthStart: OCTOBER_START, allowance: 5 }],
      failReads: true,
    });
    const instance = new PostgresSandboxDispatchBudget(
      asBudgetClient(client),
      () => OCTOBER,
    );

    await expect(instance.allowanceFor('org_acme')).resolves.toBeNull();
  });
});
