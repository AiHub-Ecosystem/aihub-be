import type { Pool } from 'pg';

/** Matches the id pattern of the table; no release writes this kind. */
export const UNRECOGNISED_KIND_ROW_ID = `edr_${'0'.repeat(24)}F1`;
const UNRECOGNISED_KIND = 'future_notice_kind';

/**
 * Queues a row of a kind no release knows, as a newer release would after its
 * migration widened the kind constraint. The gate's database is a throwaway,
 * so the widening is reproduced by dropping the constraint. The row is older
 * than every row the candidate wrote, so a claim reaches it first.
 */
export async function queueUnrecognisedKindRow(database: Pool): Promise<void> {
  await database.query(
    'ALTER TABLE email_delivery_requests DROP CONSTRAINT email_delivery_requests_kind_check',
  );
  await database.query(
    `INSERT INTO email_delivery_requests
       (id, kind, status, payload_ciphertext, attempts, created_at)
     VALUES ($1, $2, 'queued', 'opaque-fixture', 0, now() - interval '1 hour')`,
    [UNRECOGNISED_KIND_ROW_ID, UNRECOGNISED_KIND],
  );
}

export type UnrecognisedKindRowOutcome =
  | { readonly kind: 'pass'; readonly message: string }
  | { readonly kind: 'fail'; readonly message: string };

/**
 * N-1 must hand the neighbouring rows to its dispatcher and leave this row as
 * it was: still queued, never attempted, never failed or cancelled, so the
 * release that knows the kind can still send it after a roll-forward.
 */
export function classifyUnrecognisedKindRow(
  row:
    | {
        readonly status: string;
        readonly attempts: number;
        readonly payload_ciphertext: string | null;
      }
    | undefined,
): UnrecognisedKindRowOutcome {
  if (row === undefined) {
    return {
      kind: 'fail',
      message: 'the unrecognised-kind outbox row disappeared under N-1.',
    };
  }
  if (
    row.status === 'queued' &&
    row.attempts === 0 &&
    row.payload_ciphertext === 'opaque-fixture'
  ) {
    return {
      kind: 'pass',
      message:
        'N-1 left an outbox row of a kind it does not know queued and unattempted, and still dispatched the rows beside it.',
    };
  }
  return {
    kind: 'fail',
    message: `N-1 changed the unrecognised-kind outbox row (status ${row.status}, attempts ${row.attempts}).`,
  };
}

export async function readUnrecognisedKindRow(
  database: Pool,
): Promise<Parameters<typeof classifyUnrecognisedKindRow>[0]> {
  const result = await database.query<{
    status: string;
    attempts: number;
    payload_ciphertext: string | null;
  }>(
    'SELECT status, attempts, payload_ciphertext FROM email_delivery_requests WHERE id = $1',
    [UNRECOGNISED_KIND_ROW_ID],
  );
  return result.rows[0];
}
