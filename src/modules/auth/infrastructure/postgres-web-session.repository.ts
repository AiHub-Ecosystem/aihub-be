import type {
  CreateWebSessionInput,
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
}
