import { AppError } from '@/common/errors/app-error';

/**
 * Shared row readers for the auth repositories, mirroring the identity
 * repositories' `identity-row.ts`: every durable value that reaches the
 * application crosses one of these, so a column that is missing, null, or
 * outside its vocabulary fails loudly instead of flowing onward as an
 * unchecked cast.
 */

export function authStoreError(message: string): AppError {
  return new AppError({ code: 'INTERNAL_ERROR', message, retryable: false });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringValue(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function integerValue(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

/**
 * A nullable column: `null` is a state the record models, while a missing or
 * malformed value is not, so the two are told apart rather than collapsed into
 * the same `undefined`.
 */
export function nullableDateValue(
  record: Record<string, unknown>,
  key: string,
): Date | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return dateValue(record, key);
}

export function nullableStringValue(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = record[key];
  return value === null ? null : stringValue(record, key);
}

export function dateValue(
  record: Record<string, unknown>,
  key: string,
): Date | undefined {
  const value = record[key];
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value
    : undefined;
}

export function oneOf<T extends string>(
  record: Record<string, unknown>,
  key: string,
  vocabulary: readonly T[],
): T | undefined {
  const value = record[key];
  return typeof value === 'string'
    ? vocabulary.find((entry) => entry === value)
    : undefined;
}

/**
 * A nullable vocabulary column: the empty state is `null`, and anything the
 * vocabulary does not admit is refused rather than passed on as free text.
 */
export function nullableOneOf<T extends string>(
  record: Record<string, unknown>,
  key: string,
  vocabulary: readonly T[],
): T | null | undefined {
  return record[key] === null ? null : oneOf(record, key, vocabulary);
}
