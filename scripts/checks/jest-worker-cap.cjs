'use strict';
/**
 * Decides how many Jest workers the unit lane may run.
 *
 * The unit lane is bounded by free memory, not by core count. A 12-core
 * developer machine would otherwise default to 11 workers, and each worker
 * boots its own Nest DI graph, SWC transform cache, and Prisma client.
 *
 * The budget below is a conservative floor, not a measured peak: two workers
 * died from heap exhaustion on a machine reporting 2,6 GiB free on 2026-10-20,
 * while CI on a GitHub-hosted runner runs the same lane at two workers without
 * incident. One GiB per worker would have allowed that failing run to start.
 * Two GiB per worker refuses it, and leaves every healthy machine exactly where
 * it is today. Replacing the constant with a measured per-worker peak RSS is
 * the follow-up that would make this exact rather than safe.
 *
 * This helper only ever lowers the worker count. It never raises it, so an
 * unknown memory reading cannot silently consume more of the machine than the
 * lane used before this existed.
 */

const os = require('node:os');

/** Free memory required per worker before the lane is allowed to start it. */
const BYTES_PER_WORKER = 2 * 1024 ** 3;

/** The cap the unit lane ran with before this helper, and the ceiling now. */
const DEFAULT_MAX_WORKERS = 2;

/** Operator escape hatch: pins the worker count above the memory heuristic. */
const REQUEST_VARIABLE = 'AIHUB_JEST_MAX_WORKERS';

function parseRequested(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '')
    return null;
  const text = String(raw).trim();
  if (
    !/^[0-9]+$/.test(text) ||
    Number(text) < 1 ||
    !Number.isSafeInteger(Number(text))
  ) {
    // A mistyped pin must not become a mystery parallelism change two runs later.
    throw new Error(
      `${REQUEST_VARIABLE} must be a positive integer, received ${JSON.stringify(text)}.`,
    );
  }
  return Number(text);
}

/**
 * Returns the worker count and why it was chosen, so the caller can report a
 * degraded run instead of letting it look like a slow machine.
 */
function resolveMaxWorkers({ freeBytes, requested } = {}) {
  const pinned = parseRequested(requested);
  if (pinned !== null)
    return { maxWorkers: pinned, source: 'requested', capped: false };

  if (!Number.isFinite(freeBytes) || freeBytes <= 0) {
    return {
      maxWorkers: DEFAULT_MAX_WORKERS,
      source: 'unknown',
      capped: false,
    };
  }

  const affordable = Math.floor(freeBytes / BYTES_PER_WORKER);
  const maxWorkers = Math.min(DEFAULT_MAX_WORKERS, Math.max(1, affordable));
  return {
    maxWorkers,
    source: 'memory',
    capped: maxWorkers < DEFAULT_MAX_WORKERS,
  };
}

function resolveUnitLaneWorkers({
  env = process.env,
  freeBytes = os.freemem(),
} = {}) {
  return resolveMaxWorkers({ requested: env[REQUEST_VARIABLE], freeBytes });
}

module.exports = {
  REQUEST_VARIABLE,
  DEFAULT_MAX_WORKERS,
  BYTES_PER_WORKER,
  resolveMaxWorkers,
  resolveUnitLaneWorkers,
};
