CREATE TABLE email_daily_send_budgets (
  id bigint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  budget_date date NOT NULL,
  daily_budget bigint NOT NULL CHECK (daily_budget > 0),
  reserved_sends bigint NOT NULL CHECK (reserved_sends >= 0)
);
