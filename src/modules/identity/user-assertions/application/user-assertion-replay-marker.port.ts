export interface UserAssertionReplayMarkerPort {
  reserve(input: {
    readonly organizationId: string;
    readonly environment: 'production' | 'sandbox';
    readonly jti: string;
    readonly ttlSeconds: number;
  }): Promise<boolean>;
}

export const USER_ASSERTION_REPLAY_MARKER = Symbol(
  'USER_ASSERTION_REPLAY_MARKER',
);
