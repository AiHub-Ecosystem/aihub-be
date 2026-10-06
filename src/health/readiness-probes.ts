export const READINESS_PROBES = Symbol('READINESS_PROBES');

export interface ReadinessProbe {
  readonly name: string;
  readonly databaseUrl?: string | undefined;
  check(timeoutMs: number): Promise<void>;
}
