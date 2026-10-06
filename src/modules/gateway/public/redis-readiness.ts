export const GATEWAY_REDIS_READINESS = Symbol('GATEWAY_REDIS_READINESS');

export interface GatewayRedisReadiness {
  check(): Promise<void>;
}
