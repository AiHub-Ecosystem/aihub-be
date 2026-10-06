export const IDENTITY_POSTGRES_READINESS = Symbol(
  'IDENTITY_POSTGRES_READINESS',
);

export interface IdentityPostgresReadiness {
  checkControlPlaneWrite(timeoutMs: number): Promise<void>;
  checkControlPlaneRead(timeoutMs: number): Promise<void>;
}
