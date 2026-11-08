'use strict';

/**
 * Whether the knip launcher passes `--cache`.
 *
 * The knip cache (node_modules/.cache/knip) invalidates per file by mtime and
 * size and survives across runs, which pays off only where the checkout
 * persists between runs. CI runners start from a fresh checkout, so there the
 * cache is pure write overhead; any non-empty CI value disables it. Never risk
 * a stale result to save seconds: a cache miss just runs knip in full.
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {readonly string[]}
 */
function knipCacheArgs(env) {
  return env.CI ? [] : ['--cache'];
}

module.exports = { knipCacheArgs };
