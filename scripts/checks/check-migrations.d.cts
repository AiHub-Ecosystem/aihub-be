export function checkSql(
  sql: string,
  filename?: string,
): Array<{
  file: string;
  line: number;
  statement: string;
  kind: string;
  alternative: string;
}>;
export function formatViolation(v: {
  file: string;
  line: number;
  statement: string;
  kind: string;
  alternative: string;
}): string;
