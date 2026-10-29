/**
 * A downstream answer that counts against the AI Service's health: every 5xx,
 * and a 401 or 403 because it means AIHUB's own credential was rejected, not
 * that the customer sent something wrong. A circuit breaker counts these, and
 * an idempotency record they leave is kept as failed, not deleted (#845).
 * Other 4xx answers blame the request; 408 and 425 are retryable but say
 * nothing about the service.
 */
export function isDownstreamFault(status: number): boolean {
  return status >= 500 || status === 401 || status === 403;
}

/** The AI Service rejected the internal credential AIHUB presented. */
export function isDownstreamCredentialRejection(status: number): boolean {
  return status === 401 || status === 403;
}
