export const AUTH_POSTGRES_READINESS = Symbol('AUTH_POSTGRES_READINESS');

export interface AuthPostgresReadiness {
  check(timeoutMs: number): Promise<void>;
}
