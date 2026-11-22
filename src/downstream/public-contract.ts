import type { TSchema } from '@sinclair/typebox';
import { ValueErrorType } from '@sinclair/typebox/errors';
import { Value } from '@sinclair/typebox/value';

import { contractViolation } from './contract-violation';

const MAX_REPORTED_FAILURES = 3;
const MAX_PATH_LENGTH = 120;

/**
 * The first few places `value` breaks `schema`, as `path (Kind)`: the JSON
 * pointer to the field and the schema's own name for the mismatch, such as
 * `Integer` for a null where a number belongs. Both come from the schema and
 * the shape of the response, never from a value in it.
 */
export function schemaFailures(schema: TSchema, value: unknown): string {
  const failures: string[] = [];
  for (const error of Value.Errors(schema, value)) {
    // A key is provider-chosen text, so anything outside a plain field name is
    // replaced rather than copied into the log.
    const path = error.path.replace(/[^A-Za-z0-9_/.[\]-]/g, '?');
    failures.push(
      `${path.slice(0, MAX_PATH_LENGTH) || '/'} (${ValueErrorType[error.type] ?? 'Invalid'})`,
    );
    if (failures.length === MAX_REPORTED_FAILURES) {
      break;
    }
  }
  return failures.join('; ');
}

/**
 * Refuses a mapped response that breaks the public contract it is about to be
 * returned under, such as a text past its length limit. The error names where
 * and how, never what the provider wrote.
 */
export function assertPublicContract(schema: TSchema, value: unknown): void {
  if (!Value.Check(schema, value)) {
    throw contractViolation(
      schemaFailures(schema, value) ||
        'mapped response does not match the public contract',
    );
  }
}
