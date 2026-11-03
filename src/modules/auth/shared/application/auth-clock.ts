export interface AuthClock {
  now(): Date;
}

/**
 * Bound by the auth module's composition root. Every Auth use case reads time
 * through it, so a test fixes the clock without touching the wall clock.
 */
export const AUTH_CLOCK = Symbol('AUTH_CLOCK');
