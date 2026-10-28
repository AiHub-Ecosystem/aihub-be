import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import {
  classifyUnrecognisedKindRow,
  readUnrecognisedKindRow,
} from './n-minus-one-outbox-probes';
import {
  PREVIOUS_PORT,
  check,
  expect2xx,
  expectStatus,
  isRecord,
  organizationIdOf,
  request,
  stubState,
  waitFor,
} from './n-minus-one-runtime';

async function organizationConstraintRejectsZeroWidthSpace(
  database: Pool,
  organizationId: string,
): Promise<boolean> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('UPDATE organizations SET name = $2 WHERE id = $1', [
        organizationId,
        'Rollback\u200bProbe',
      ]);
    } catch (error) {
      return (
        isRecord(error) &&
        error.code === '23514' &&
        error.constraint === 'organizations_name_display_text_check'
      );
    }
    return false;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

type ZeroWidthOrganizationWriteOutcome =
  | { readonly kind: 'pass'; readonly message: string }
  | { readonly kind: 'release_hold'; readonly message: string }
  | { readonly kind: 'fail'; readonly message: string };

export function classifyZeroWidthOrganizationWrite(
  status: number,
  constraintConfirmed: boolean,
): ZeroWidthOrganizationWriteOutcome {
  if (status === 400) {
    return {
      kind: 'pass',
      message:
        'N-1 rejected the known Organization-name probe at its request boundary.',
    };
  }
  if (status === 500) {
    return {
      kind: 'release_hold',
      message: constraintConfirmed
        ? 'N-1 returned HTTP 500 for the zero-width-space write; PostgreSQL confirmed the ADR-0121 constraint, but that independent probe cannot attribute the response to the constraint.'
        : 'N-1 returned HTTP 500 for the zero-width-space write, and PostgreSQL did not confirm the ADR-0121 constraint.',
    };
  }
  return {
    kind: 'fail',
    message:
      status === 201
        ? 'N-1 wrote a zero-width-space Organization name despite the candidate constraint.'
        : `N-1 zero-width-space write returned unexpected HTTP ${status}.`,
  };
}

export async function verifyDurableReads(input: {
  readonly database: Pool;
  readonly organizationCreateKey: string;
  readonly organizationId: string;
  readonly userToken: string;
  readonly previousSha: string;
  readonly candidateSha: string;
  readonly report: string[];
  readonly failures: string[];
}): Promise<void> {
  const {
    database,
    organizationCreateKey,
    organizationId,
    userToken,
    previousSha,
    candidateSha,
    report,
    failures,
  } = input;
  const previousEmail = await waitFor(
    stubState,
    (state) => state.emailCalls.includes('previous'),
    'N-1 did not read and dispatch the candidate email request',
    30_000,
  );
  check(
    previousEmail.emailCalls.includes('previous'),
    'N-1 email outbox read was not observed',
  );
  report.push('PASS: N-1 started and read the candidate email outbox request.');

  const unrecognised = classifyUnrecognisedKindRow(
    await readUnrecognisedKindRow(database),
  );
  if (unrecognised.kind === 'pass') {
    report.push(`PASS: ${unrecognised.message}`);
  } else {
    failures.push(`FAIL: ${unrecognised.message}`);
  }

  const replay = await request(PREVIOUS_PORT, 'POST', '/v1/organizations', {
    token: userToken,
    idempotencyKey: organizationCreateKey,
    body: { name: 'Release compatibility fixture' },
  });
  expectStatus(replay, 201, 'N-1 idempotency replay');
  check(
    organizationIdOf(replay) === organizationId,
    'N-1 replay changed the organization result',
  );

  const audit = await request(
    PREVIOUS_PORT,
    'GET',
    `/v1/organizations/${organizationId}/audit-events`,
    { token: userToken },
  );
  expect2xx(audit, 'N-1 audit read');
  const auditData = audit.body?.data as Record<string, unknown> | undefined;
  check(
    Array.isArray(auditData?.events) && auditData.events.length > 0,
    'N-1 did not read candidate audit data',
  );
  report.push(
    'PASS: N-1 replayed the candidate idempotency record and read its audit event.',
  );

  const previousUnicodeWrite = await request(
    PREVIOUS_PORT,
    'POST',
    '/v1/organizations',
    {
      token: userToken,
      idempotencyKey: `compat-unicode-${randomUUID()}`,
      body: { name: 'Rollback\u200bProbe' },
    },
  );
  const constraintConfirmed =
    previousUnicodeWrite.status === 500 &&
    (await organizationConstraintRejectsZeroWidthSpace(
      database,
      organizationId,
    ));
  const outcome = classifyZeroWidthOrganizationWrite(
    previousUnicodeWrite.status,
    constraintConfirmed,
  );
  const revisionContext = `(N-1 ${previousSha}, candidate ${candidateSha})`;
  if (outcome.kind === 'pass') {
    report.push(`PASS: ${outcome.message} ${revisionContext}`);
  } else {
    failures.push(
      `${outcome.kind === 'release_hold' ? 'RELEASE HOLD' : 'FAIL'}: ${outcome.message} ${revisionContext}`,
    );
  }
}
