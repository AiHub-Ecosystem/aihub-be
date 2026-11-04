/**
 * The one SQL statement of "a billable request": a successful `usage_records`
 * row that counts once. The column is constrained to 0 or 1 (migration 0005),
 * so counting these rows equals summing the column. Pass the table alias when
 * the query joins.
 */
export function billableRequestSql(alias = ''): string {
  const prefix = alias === '' ? '' : `${alias}.`;
  return `${prefix}outcome = 'success' AND ${prefix}billable_requests = 1`;
}
