/**
 * The one set of readers for a row the driver returned. Auth, Identity, and
 * Metering read every durable value through these, so a column that is
 * missing, null, or outside its vocabulary fails the same way in all three
 * instead of flowing onward as an unchecked cast. A reader returns `undefined`
 * for a value it refuses; a nullable reader returns `null` only for a SQL
 * NULL, so "empty by design" and "malformed" stay different answers.
 */

type Row = Record<string, unknown>;

/** A valid `Date` only, as a copy so no caller mutates the driver's object. */
export function asDate(value: unknown): Date | undefined {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? new Date(value.getTime())
    : undefined;
}

/**
 * A valid `Date`, or a string `Date` parses, as a copy. For a column a query
 * may return as text (a JSON aggregate, a cast); a plain timestamp column
 * uses `asDate`.
 */
export function asDateOrIso(value: unknown): Date | undefined {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return asDate(value);
}

export function stringValue(record: Row, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function nullableStringValue(
  record: Row,
  key: string,
): string | null | undefined {
  return record[key] === null ? null : stringValue(record, key);
}

export function integerValue(record: Row, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

export function positiveIntegerValue(
  record: Row,
  key: string,
): number | undefined {
  const value = integerValue(record, key);
  return value !== undefined && value > 0 ? value : undefined;
}

export function nullableNonNegativeIntegerValue(
  record: Row,
  key: string,
): number | null | undefined {
  if (record[key] === null) {
    return null;
  }
  const value = integerValue(record, key);
  return value !== undefined && value >= 0 ? value : undefined;
}

export function booleanValue(record: Row, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function stringArrayValue(
  record: Row,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

export function dateValue(record: Row, key: string): Date | undefined {
  return asDate(record[key]);
}

export function nullableDateValue(
  record: Row,
  key: string,
): Date | null | undefined {
  return record[key] === null ? null : dateValue(record, key);
}

export function oneOf<T extends string>(
  record: Row,
  key: string,
  vocabulary: readonly T[],
): T | undefined {
  const value = record[key];
  return typeof value === 'string'
    ? vocabulary.find((entry) => entry === value)
    : undefined;
}

export function nullableOneOf<T extends string>(
  record: Row,
  key: string,
  vocabulary: readonly T[],
): T | null | undefined {
  return record[key] === null ? null : oneOf(record, key, vocabulary);
}
