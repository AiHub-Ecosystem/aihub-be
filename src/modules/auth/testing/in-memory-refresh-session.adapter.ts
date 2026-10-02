import type {
  CreateRefreshSessionInput,
  RefreshSessionRepositoryPort,
  RefreshTokenRecord,
  RefreshTokenRotationResult,
  RotateRefreshTokenInput,
} from '@/modules/auth/application/refresh-session-repository.port';
import type { InMemoryAuthState } from './in-memory-auth.state';

export class InMemoryRefreshSessionAdapter
  implements RefreshSessionRepositoryPort
{
  /** Fails the next durable session write, as a database outage would. */
  failCreateRefreshSession = false;
  /** Fails the next durable lookup, as an unreachable store would. */
  failFindRefreshToken = false;

  constructor(private readonly state: InMemoryAuthState) {}

  async createRefreshSession(input: CreateRefreshSessionInput): Promise<void> {
    if (this.failCreateRefreshSession) {
      throw new Error('durable store unavailable');
    }
    this.state.refreshTokens.set(input.token.hash, {
      tokenId: input.token.id,
      familyId: input.token.familyId,
      userId: input.userId,
      expiresAt: input.token.expiresAt,
      usedAt: undefined,
      revokedAt: undefined,
    });
  }

  async findRefreshTokenByHash(
    tokenHash: string,
  ): Promise<RefreshTokenRecord | undefined> {
    if (this.failFindRefreshToken) {
      throw new Error('durable store unavailable');
    }
    return this.state.refreshTokens.get(tokenHash);
  }

  async rotateRefreshToken(
    input: RotateRefreshTokenInput,
  ): Promise<RefreshTokenRotationResult> {
    const current = this.state.refreshTokens.get(input.tokenHash);
    if (current === undefined) {
      return { kind: 'invalid', reason: 'missing' };
    }
    if (this.state.accounts.get(current.userId)?.status !== 'active') {
      return { kind: 'invalid', reason: 'inactive' };
    }
    if (current.revokedAt !== undefined) {
      this.revokeFamily(current.familyId, input.now);
      return { kind: 'invalid', reason: 'revoked' };
    }
    if (current.usedAt !== undefined) {
      this.revokeFamily(current.familyId, input.now);
      return { kind: 'invalid', reason: 'used' };
    }
    if (current.expiresAt.getTime() <= input.now.getTime()) {
      return { kind: 'invalid', reason: 'expired' };
    }

    this.state.refreshTokens.set(input.tokenHash, {
      ...current,
      usedAt: input.now,
    });
    this.state.refreshTokens.set(input.successor.hash, {
      tokenId: input.successor.id,
      familyId: input.successor.familyId,
      userId: current.userId,
      expiresAt: input.successor.expiresAt,
      usedAt: undefined,
      revokedAt: undefined,
    });
    return { kind: 'rotated', userId: current.userId };
  }

  async revokeRefreshFamilyByTokenHash(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<void> {
    const current = this.state.refreshTokens.get(input.tokenHash);
    if (current === undefined) {
      return;
    }
    this.revokeFamily(current.familyId, input.now);
  }

  private revokeFamily(familyId: string, now: Date): void {
    for (const [hash, session] of this.state.refreshTokens) {
      if (session.familyId === familyId && session.revokedAt === undefined) {
        this.state.refreshTokens.set(hash, { ...session, revokedAt: now });
      }
    }
  }
}
