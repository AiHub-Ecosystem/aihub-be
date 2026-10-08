import type {
  CreateWebSessionInput,
  ExchangeableWebSession,
  FindExchangeableWebSessionInput,
  RenewWebSessionInput,
  WebSessionRepositoryPort,
} from '@/modules/auth/application/web-session-repository.port';
import type { PostgresAuthQueryClient } from './postgres-auth.client';

/**
 * Stores only the token hash. `last_renewed_at` starts equal to `created_at`:
 * creation is the first renewal, so the exchange throttle has a baseline to
 * measure from without a separate column.
 */
export class PostgresWebSessionRepository implements WebSessionRepositoryPort {
  constructor(private readonly client: PostgresAuthQueryClient) {}

  async createWebSession(input: CreateWebSessionInput): Promise<void> {
    await this.client.query(
      `
        INSERT INTO web_sessions (
          id, user_account_id, token_hash,
          created_at, expires_at, last_renewed_at
        )
        VALUES ($1, $2, $3, $4, $5, $4)
      `,
      [
        input.sessionId,
        input.userId,
        input.token.hash,
        input.now,
        input.token.expiresAt,
      ],
    );
  }

  async findExchangeableWebSession(
    input: FindExchangeableWebSessionInput,
  ): Promise<ExchangeableWebSession | undefined> {
    const rows = await this.client.query(
      `
        SELECT user_account_id
        FROM web_sessions
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > $2
      `,
      [input.tokenHash, input.now],
    );
    const userId = rows[0]?.['user_account_id'];
    if (typeof userId !== 'string') {
      return undefined;
    }
    return { userId };
  }

  /**
   * The forward-only sliding expiry, as one conditional statement.
   *
   * Every rule is a guard in the `WHERE` clause, so the engine decides and this
   * method never reads the row first: `revoked_at IS NULL` and
   * `expires_at > renewed_at` keep the renewal off a session that cannot be
   * exchanged, `last_renewed_at <= renewed_at_before` is the one-write-per-hour
   * throttle, and `expires_at < expiresAt` is the forward-only rule enforced
   * by the store rather than trusted from the caller. `expires_at` is a value
   * the caller derived, never the row's own value plus an increment, so two
   * concurrent exchanges can only ever settle on the later of the two.
   *
   * `RETURNING id` is how the caller learns whether a row was written; a
   * throttled or refused renewal returns no row, which is a normal outcome and
   * not an error.
   */
  async renewWebSession(input: RenewWebSessionInput): Promise<boolean> {
    const rows = await this.client.query(
      `
        UPDATE web_sessions
        SET expires_at = $2, last_renewed_at = $3
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > $3
          AND expires_at < $2
          AND last_renewed_at <= $4
        RETURNING id
      `,
      [
        input.tokenHash,
        input.expiresAt,
        input.renewedAt,
        input.renewedAtBefore,
      ],
    );
    return rows.length > 0;
  }
}
