import type { EmailDeliveryKind } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type {
  EmailDailyBudgetReservation,
  EmailDailySendBudgetPort,
} from '@/modules/auth/email-delivery/application/email-send-daily-budget.port';
import type { PrismaPool } from '@/modules/persistence/persistence.module';

export const EMAIL_DAILY_SEND_BUDGET_SQL = `
WITH today AS (
  SELECT (statement_timestamp() AT TIME ZONE 'UTC')::date AS budget_date
), reservation AS (
  INSERT INTO email_daily_send_budgets (
    id, budget_date, daily_budget, reserved_sends
  )
  SELECT 1, today.budget_date, $2, 1 FROM today
  ON CONFLICT (id) DO UPDATE SET
    budget_date = EXCLUDED.budget_date,
    daily_budget = CASE
      WHEN email_daily_send_budgets.budget_date = EXCLUDED.budget_date
        THEN LEAST(email_daily_send_budgets.daily_budget, EXCLUDED.daily_budget)
      ELSE EXCLUDED.daily_budget
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
    + CASE
      WHEN $1 = 'organization_invite_email'
        THEN GREATEST(1, CEIL(
          CASE
            WHEN email_daily_send_budgets.budget_date = EXCLUDED.budget_date
              THEN LEAST(
                email_daily_send_budgets.daily_budget,
                EXCLUDED.daily_budget
              )
            ELSE EXCLUDED.daily_budget
          END * 0.2
        )::integer)
      ELSE 0
    END
    < CASE
      WHEN email_daily_send_budgets.budget_date = EXCLUDED.budget_date
        THEN LEAST(
          email_daily_send_budgets.daily_budget,
          EXCLUDED.daily_budget
        )
      ELSE EXCLUDED.daily_budget
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
    $2
  ) AS "limit",
  GREATEST(
    1,
    CEIL(EXTRACT(EPOCH FROM (
      ((SELECT budget_date + 1 FROM today)::timestamp AT TIME ZONE 'UTC')
        - statement_timestamp()
    )) * 1000)::bigint
  ) AS retry_after_ms
`;

interface EmailDailyBudgetRow {
  readonly reserved: boolean;
  readonly used: number | string;
  readonly limit: number | string;
  readonly retry_after_ms: number | string;
}

export class PostgresEmailDailySendBudget implements EmailDailySendBudgetPort {
  constructor(
    private readonly getPool: () => PrismaPool,
    private readonly dailyBudget: number,
  ) {}

  async reserve(kind: EmailDeliveryKind): Promise<EmailDailyBudgetReservation> {
    const result = await this.getPool().query({
      text: EMAIL_DAILY_SEND_BUDGET_SQL,
      values: [kind, this.dailyBudget],
    });
    const row = result.rows[0] as EmailDailyBudgetRow | undefined;
    if (row === undefined) {
      return { reserved: false, retryAfterMs: 5_000 };
    }
    return row.reserved
      ? { reserved: true }
      : { reserved: false, retryAfterMs: Number(row.retry_after_ms) };
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
      values: [this.dailyBudget],
    });
    const row = result.rows[0] as EmailDailyBudgetRow | undefined;
    if (row === undefined) throw new Error('email daily budget is unavailable');
    return { used: Number(row.used), limit: Number(row.limit) };
  }
}
