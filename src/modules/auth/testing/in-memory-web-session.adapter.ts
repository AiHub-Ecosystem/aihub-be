import type {
  CreateWebSessionInput,
  WebSessionRepositoryPort,
} from '@/modules/auth/application/web-session-repository.port';
import type { InMemoryAuthState } from '@/modules/auth/testing/in-memory-auth.state';

export class InMemoryWebSessionAdapter implements WebSessionRepositoryPort {
  /** Fails the next durable write, as a database outage would. */
  failCreateWebSession = false;

  constructor(private readonly state: InMemoryAuthState) {}

  async createWebSession(input: CreateWebSessionInput): Promise<void> {
    if (this.failCreateWebSession) {
      throw new Error('durable store unavailable');
    }
    this.state.webSessions.set(input.token.hash, {
      sessionId: input.sessionId,
      userId: input.userId,
      tokenHash: input.token.hash,
      createdAt: input.now,
      expiresAt: input.token.expiresAt,
      lastRenewedAt: input.now,
      revokedAt: undefined,
    });
  }
}
