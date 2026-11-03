import type { LoginRequest } from '@/contracts/auth/local-auth';
import type { IssuedSession } from './session-token-issuers';

export type LoginOutcome =
  | { readonly kind: 'session'; readonly session: IssuedSession }
  | { readonly kind: 'mfa-required' };

export interface LocalSessionPort {
  currentUser(userId: string): Promise<{ readonly username: string }>;
  login(input: LoginRequest, ip: string): Promise<LoginOutcome>;
  refresh(rawToken: string | undefined, ip: string): Promise<IssuedSession>;
  logout(rawToken: string | undefined): Promise<void>;
}

export class RefreshRotationCommittedError extends Error {
  constructor() {
    super('refresh rotation committed before access-token issuance');
    this.name = 'RefreshRotationCommittedError';
  }
}

export const LOCAL_SESSION = Symbol('LOCAL_SESSION');
