/**
 * What `generate-prisma-client.mjs` does for one request, decided from the
 * stamp on disk (#1611).
 *
 * The stamp records the input hash (schema and pinned Prisma versions) and the
 * strongest mode that produced the outputs. `--runtime` writes `client.ts` plus
 * a compiled `client.js`, a superset of the plain outputs, so a runtime stamp
 * serves a plain request and a plain stamp needs only the compile step for a
 * runtime request. Folding the mode into the hash made the two modes
 * invalidate each other and regenerate the client 2-3 times per `verify`.
 *
 * Kept apart from the script so a spec can run the plan without Prisma. The
 * Docker build context lists it beside the script in `.dockerignore`.
 */

/** @typedef {'plain' | 'runtime'} Mode */
/** @typedef {{ hash: string, mode: Mode }} Stamp */
/** @typedef {'skip' | 'compile' | 'generate'} Plan */

/** @param {Stamp} stamp @returns {string} */
function formatStamp(stamp) {
  return `${stamp.hash} ${stamp.mode}\n`;
}

/**
 * A stamp written before the mode was recorded has no mode and parses as
 * absent, so the next run regenerates once.
 * @param {string} text @returns {Stamp | undefined}
 */
function parseStamp(text) {
  const [hash, mode] = text.trim().split(/\s+/);
  if (hash === undefined || hash === '') return undefined;
  if (mode !== 'plain' && mode !== 'runtime') return undefined;
  return { hash, mode };
}

/**
 * @param {{
 *   runtime: boolean,
 *   hash: string,
 *   stamp: Stamp | undefined,
 *   hasClientTs: boolean,
 *   hasClientJs: boolean,
 *   hasKyselyTs?: boolean,
 * }} input
 * @returns {Plan}
 */
function planGeneration({
  runtime,
  hash,
  stamp,
  hasClientTs,
  hasClientJs,
  hasKyselyTs = true,
}) {
  if (
    stamp === undefined ||
    stamp.hash !== hash ||
    !hasClientTs ||
    !hasKyselyTs
  ) {
    return 'generate';
  }
  if (!runtime) return 'skip';
  return stamp.mode === 'runtime' && hasClientJs ? 'skip' : 'compile';
}

/**
 * The stamp to leave on disk after running `plan`. A skip changes nothing, so a
 * plain run never downgrades a runtime stamp.
 * @param {Plan} plan @param {boolean} runtime @param {string} hash
 * @param {Stamp | undefined} stamp @returns {Stamp | undefined}
 */
function nextStamp(plan, runtime, hash, stamp) {
  if (plan === 'skip') return stamp;
  return { hash, mode: runtime ? 'runtime' : 'plain' };
}

module.exports = { formatStamp, nextStamp, parseStamp, planGeneration };
