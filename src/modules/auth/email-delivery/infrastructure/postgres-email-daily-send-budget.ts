import type {
  EmailDailyBudgetReservation,
  EmailDailySendBudgetCategory,
  EmailDailySendBudgetLimits,
  EmailDailySendBudgetPort,
} from '@/modules/auth/email-delivery/application/email-send-daily-budget.port';
import type { PrismaPool } from '@/modules/persistence/persistence.module';

export const EMAIL_DAILY_SEND_BUDGET_SQL = `
WITH today AS (
  SELECT (statement_timestamp() AT TIME ZONE 'UTC')::date AS budget_date
), reservation AS (
  INSERT INTO email_daily_send_budgets (
    id, budget_date, daily_budget, invitation_budget, reserved_sends
  )
  SELECT 1, today.budget_date, $2::bigint, $3::bigint, 1 FROM today
  WHERE CASE WHEN $1::text = 'invitation' THEN $3::bigint ELSE $2::bigint END > 0
  ON CONFLICT (id) DO UPDATE SET
    budget_date = EXCLUDED.budget_date,
    daily_budget = CASE
      WHEN email_daily_send_budgets.budget_date = EXCLUDED.budget_date
        THEN LEAST(email_daily_send_budgets.daily_budget, EXCLUDED.daily_budget)
      ELSE EXCLUDED.daily_budget
    END,
    invitation_budget = CASE
      WHEN email_daily_send_budgets.budget_date = EXCLUDED.budget_date
        THEN LEAST(
          email_daily_send_budgets.invitation_budget,
          EXCLUDED.invitation_budget
        )
      ELSE EXCLUDED.invitation_budget
    END,
    reserved_sends = CASE
      WHEN email_daily_send_budgets.budget_date = EXCLUDED.budget_date
        THEN email_daily_send_budgets.reserved_sends + 1
      ELSE 1
    END
  WHERE
    CASE
      WHEN email_daily_send_budgets.budget_date = EXCLUDED.budget_date
        THEN email_daily_send_budgets.reserved_sends
      ELSE 0
    END
    < CASE
      WHEN $1::text = 'invitation' THEN
        CASE
          WHEN email_daily_send_budgets.budget_date = EXCLUDED.budget_date
            THEN LEAST(
              email_daily_send_budgets.invitation_budget,
              EXCLUDED.invitation_budget
            )
          ELSE EXCLUDED.invitation_budget
        END
      ELSE
        CASE
          WHEN email_daily_send_budgets.budget_date = EXCLUDED.budget_date
            THEN LEAST(
              email_daily_send_budgets.daily_budget,
              EXCLUDED.daily_budget
            )
          ELSE EXCLUDED.daily_budget
        END
    END
  RETURNING reserved_sends, daily_budget
)
SELECT EXISTS(SELECT 1 FROM reservation) AS reserved,
  COALESCE(
    (SELECT reserved_sends FROM reservation),
    (SELECT reserved_sends FROM email_daily_send_budgets
      WHERE id = 1 AND budget_date = (SELECT budget_date FROM today)),
    0
  ) AS used,
  COALESCE(
    (SELECT daily_budget FROM reservation),
    (SELECT daily_budget FROM email_daily_send_budgets
      WHERE id = 1 AND budget_date = (SELECT budget_date FROM today)),
    $2::bigint
  ) AS "limit",
  GREATEST(
    1,
    CEIL(EXTRACT(EPOCH FROM (
      ((SELECT budget_date + 1 FROM today)::timestamp AT TIME ZONE 'UTC')
        - statement_timestamp()
    )) * 1000)::bigint
  ) AS retry_after_ms
`;

function rowProperty(value: unknown, property: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Reflect.get(value, property);
}

function safeNonnegativeInteger(value: unknown): number | undefined {
  if (
    (typeof value !== 'number' &&
      (typeof value !== 'string' || !/^\d+$/.test(value))) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 0
  ) {
    return undefined;
  }
  return Number(value);
}

function mapReservationRow(value: unknown):
  | {
      readonly reserved: boolean;
      readonly used: number;
      readonly limit: number;
      readonly retryAfterMs: number;
    }
  | undefined {
  const reserved = rowProperty(value, 'reserved');
  const used = safeNonnegativeInteger(rowProperty(value, 'used'));
  const limit = safeNonnegativeInteger(rowProperty(value, 'limit'));
  const retryAfterMs = safeNonnegativeInteger(
    rowProperty(value, 'retry_after_ms'),
  );
  if (
    typeof reserved !== 'boolean' ||
    used === undefined ||
    limit === undefined ||
    retryAfterMs === undefined
  ) {
    return undefined;
  }
  return { reserved, used, limit, retryAfterMs };
}

function mapUsageRow(
  value: unknown,
): { readonly used: number; readonly limit: number } | undefined {
  const used = safeNonnegativeInteger(rowProperty(value, 'used'));
  const limit = safeNonnegativeInteger(rowProperty(value, 'limit'));
  if (used === undefined || limit === undefined) return undefined;
  return { used, limit };
}

export class PostgresEmailDailySendBudget implements EmailDailySendBudgetPort {
  constructor(
    private readonly getPool: () => PrismaPool,
    private readonly limits: EmailDailySendBudgetLimits,
  ) {}

  async reserve(
    category: EmailDailySendBudgetCategory,
  ): Promise<EmailDailyBudgetReservation> {
    const result = await this.getPool().query({
      text: EMAIL_DAILY_SEND_BUDGET_SQL,
      values: [category, this.limits.dailyBudget, this.limits.invitationBudget],
    });
    const row = mapReservationRow(result.rows[0]);
    if (row === undefined) {
      return { reserved: false, retryAfterMs: 5_000 };
    }
    return row.reserved
      ? { reserved: true }
      : { reserved: false, retryAfterMs: row.retryAfterMs };
  }

  async usage(): Promise<{ readonly used: number; readonly limit: number }> {
    const result = await this.getPool().query({
      text: `
        SELECT COALESCE((
          SELECT reserved_sends
          FROM email_daily_send_budgets
          WHERE id = 1
            AND budget_date = (statement_timestamp() AT TIME ZONE 'UTC')::date
        ), 0) AS used,
        COALESCE((
          SELECT daily_budget
          FROM email_daily_send_budgets
          WHERE id = 1
            AND budget_date = (statement_timestamp() AT TIME ZONE 'UTC')::date
        ), $1) AS "limit"`,
      values: [this.limits.dailyBudget],
    });
    const row = mapUsageRow(result.rows[0]);
    if (row === undefined) throw new Error('email daily budget is unavailable');
    return row;
  }
}
