/**
 * One run budget for every property test, so CI time stays flat and a failure
 * reproduces: the seed is fixed, the run count is bounded. To explore beyond
 * it locally, raise `numRuns` or change `seed` in the failing spec only.
 */
export const PROPERTY_OPTIONS = { seed: 329, numRuns: 200 } as const;
