import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

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

export async function verifyDurableReads(input: {
  readonly database: Pool;
  readonly organizationCreateKey: string;
  readonly organizationId: string;
  readonly userToken: string;
  readonly report: string[];
  readonly failures: string[];
}): Promise<void> {
  const {
    database,
    organizationCreateKey,
    organizationId,
    userToken,
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
  if (previousUnicodeWrite.status === 500) {
    const expectedConstraint =
      await organizationConstraintRejectsZeroWidthSpace(
        database,
        organizationId,
      );
    if (expectedConstraint) {
      report.push(
        'EXCEPTION: PostgreSQL independently confirmed the ADR-0121 organizations_name_display_text_check (23514).',
      );
      failures.push(
        'N-1 returned HTTP 500 for the zero-width-space write; its cause could not be tied to the accepted constraint exception.',
      );
    } else {
      failures.push(
        'N-1 returned HTTP 500 for the zero-width-space write, but PostgreSQL did not confirm the expected organization-name CHECK violation.',
      );
    }
  } else if (previousUnicodeWrite.status === 201) {
    failures.push(
      'N-1 wrote a zero-width-space Organization name despite the candidate constraint; verify the constraint gate.',
    );
  } else if (previousUnicodeWrite.status !== 400) {
    failures.push(
      `N-1 zero-width-space write returned unexpected HTTP ${previousUnicodeWrite.status}.`,
    );
  } else {
    report.push(
      'PASS: N-1 rejected the known Organization-name probe at its request boundary.',
    );
  }
}
