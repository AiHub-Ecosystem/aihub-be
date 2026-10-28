import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import {
  CANDIDATE_PORT,
  PREVIOUS_PORT,
  check,
  expectStatus,
  request,
  stubState,
  waitFor,
} from './n-minus-one-runtime';

export async function verifyPasswordRolloutCompatibility(input: {
  readonly database: Pool;
  readonly previousSha: string;
  readonly candidateSha: string;
  readonly report: string[];
}): Promise<void> {
  const { database, previousSha, candidateSha, report } = input;
  const setting = process.env.AIHUB_EMAIL_VERIFICATION_REQUIRES_PASSWORD;
  check(
    setting === 'true' || setting === 'false',
    'AIHUB_EMAIL_VERIFICATION_REQUIRES_PASSWORD must be true or false in CI',
  );
  const requiresPassword = setting === 'true';
  const username = `rollback-${randomUUID().replaceAll('-', '').slice(0, 23)}`;
  const password = `Release-compat-${randomUUID()}!A9`;
  const tokenBefore = (await stubState()).verificationToken;
  const registration = await request(
    CANDIDATE_PORT,
    'POST',
    '/v1/auth/register',
    {
      body: {
        email: `${username}@example.invalid`,
        username,
        password,
      },
    },
  );
  expectStatus(
    registration,
    201,
    'candidate verification-password registration',
  );
  const state = await waitFor(
    stubState,
    (value) =>
      typeof value.verificationToken === 'string' &&
      value.verificationToken !== tokenBefore,
    'candidate verification email was not sent to the compatibility stub',
  );
  const token = state.verificationToken;
  check(typeof token === 'string', 'candidate verification token is missing');

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const issued = await database.query<{
    readonly requiresPassword: boolean;
    readonly status: string;
  }>(
    `SELECT token.requires_password AS "requiresPassword", account.status
       FROM email_verification_tokens token
       JOIN user_accounts account ON account.id = token.user_account_id
      WHERE token.token_hash = $1`,
    [tokenHash],
  );
  check(
    issued.rows[0]?.requiresPassword === requiresPassword &&
      issued.rows[0]?.status === 'pending_verification',
    'candidate verification token does not match the configured rollout mode',
  );

  const previousVerify = await request(
    PREVIOUS_PORT,
    'POST',
    '/v1/auth/verify-email',
    { body: { token } },
  );
  const result = await database.query<{
    readonly consumedAt: Date | null;
    readonly passwordFailures: number;
    readonly status: string;
  }>(
    `SELECT token.consumed_at AS "consumedAt",
            token.password_failures AS "passwordFailures", account.status
       FROM email_verification_tokens token
       JOIN user_accounts account ON account.id = token.user_account_id
      WHERE token.token_hash = $1`,
    [tokenHash],
  );
  const after = result.rows[0];
  if (requiresPassword) {
    const error = previousVerify.body?.error;
    check(
      previousVerify.status === 400 &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AUTH_VERIFICATION_PASSWORD_INVALID',
      `RELEASE HOLD: N-1 ${previousSha} does not enforce the password requirement on candidate ${candidateSha} verification tokens`,
    );
    check(
      after?.consumedAt === null &&
        after.passwordFailures === 0 &&
        after.status === 'pending_verification',
      'N-1 missing-password refusal changed the candidate verification token',
    );
    report.push(
      `PASS: N-1 ${previousSha} refused to consume a password-required token issued by N ${candidateSha} without changing it.`,
    );
    return;
  }

  check(
    previousVerify.status === 204,
    `N-1 ${previousSha} could not verify a feature-off candidate token (${previousVerify.status})`,
  );
  check(
    after?.consumedAt instanceof Date && after.status === 'active',
    'feature-off N-1 verification did not activate the pending account',
  );
  report.push(
    `PASS: feature-off rollout let N-1 ${previousSha} consume N ${candidateSha}'s verification token with the existing email-only behavior.`,
  );
}
