/** @typedef {{events: number, rate: number, concurrency: number}} RunOptions */

/** @param {string[]} args @returns {RunOptions} */
export function parseOptions(args) {
  const options = { events: 10_000, rate: 1_000, concurrency: 32 };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!['--events', '--rate', '--concurrency'].includes(name)) {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = Number(args[index + 1]);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
    const key =
      name === '--events'
        ? 'events'
        : name === '--rate'
          ? 'rate'
          : 'concurrency';
    options[key] = value;
    index += 1;
  }
  return options;
}

/** @param {string} connectionString */
export function assertSafeDatabaseUrl(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('AIHUB_OUTBOX_EVAL_DATABASE_URL must be a PostgreSQL URL');
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    database !== 'aihub_outbox_eval'
  ) {
    throw new Error(
      'Evaluation runner is restricted to localhost database aihub_outbox_eval',
    );
  }
}

/** @param {number[]} values @returns {{count: number, p50: number | null, p95: number | null, p99: number | null}} */
export function summarize(values) {
  if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.ceil(fraction * sorted.length) - 1];
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
  };
}
