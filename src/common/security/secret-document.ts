import { readFileSync } from 'node:fs';

import { isRecord } from '@/common/is-record';

export type SecretDocument = Readonly<Record<string, unknown>>;

/** Builds the error a loader throws for its own failure class. */
export type FailWith = (message: string) => Error;

export function readUtf8File(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * The shared checks of a rendered secret document. Each loader keeps its own
 * error class and passes it as `fail`, so the parsing rules and their message
 * text exist once and the failure type stays the caller's.
 */
export function asDocument(
  value: unknown,
  label: string,
  fail: FailWith,
): SecretDocument {
  if (!isRecord(value)) {
    throw fail(`${label} has an invalid shape`);
  }
  return value;
}

export function assertOnlyFields(
  record: SecretDocument,
  allowedKeys: readonly string[],
  label: string,
  fail: FailWith,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw fail(`${label} contains unexpected fields`);
  }
}

export function requiredDocumentString(
  record: SecretDocument,
  key: string,
  missingMessage: string,
  fail: FailWith,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw fail(missingMessage);
  }
  return value;
}
