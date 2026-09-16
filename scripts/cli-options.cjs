/**
 * Option parsers that are worth testing on their own.
 *
 * `cli.mjs` runs its `main()` on import, so nothing in it can be exercised
 * from a test. These live here instead: they decide how much an organization
 * is allowed to spend, which is the kind of value that should not be wrong
 * because nobody could check it.
 */
class CliUsageError extends Error {}

function usageError() {
  throw new CliUsageError('Invalid CLI arguments');
}

/**
 * A monthly request ceiling, or `null` for no ceiling.
 *
 * Zero is accepted and means "no requests at all", which is a legitimate way
 * to freeze an organization without revoking its keys. An absent option means
 * unlimited, matching the column's nullable default — so a quota is something
 * you opt into, and forgetting the flag never silently caps a real tenant.
 */
function quotaOption(options, name) {
  const raw = options.get(name);
  if (raw === undefined) {
    return null;
  }

  // `Number('')` is 0, so a blank value would otherwise read as "no requests
  // allowed" and freeze the organization the flag was meant to budget.
  const text = raw.trim();
  const value = Number(text);
  if (text.length === 0 || !Number.isInteger(value) || value < 0) {
    usageError();
  }

  return value;
}

/**
 * An explicit `true`/`false`. The argument parser only understands
 * `--name value` pairs, so there are no bare flags to accidentally invert,
 * and an unrecognised word is rejected rather than read as false.
 */
function booleanOption(options, name, fallback = false) {
  const raw = options.get(name);
  if (raw === undefined) {
    return fallback;
  }

  const value = raw.trim().toLowerCase();
  if (value !== 'true' && value !== 'false') {
    usageError();
  }

  return value === 'true';
}

const ALLOWED_ENVIRONMENTS = new Set([
  'development',
  'staging',
  'production',
  'sandbox',
]);

function environmentListOption(options, name, fallback = 'production') {
  const raw = options.get(name) ?? fallback;
  const values = raw.split(',').map((item) => item.trim());

  if (
    values.length === 0 ||
    values.some((value) => value.length === 0) ||
    new Set(values).size !== values.length ||
    values.some((value) => !ALLOWED_ENVIRONMENTS.has(value)) ||
    (values.includes('sandbox') && values.length !== 1)
  ) {
    usageError();
  }

  return values;
}

module.exports = {
  CliUsageError,
  usageError,
  quotaOption,
  booleanOption,
  environmentListOption,
};
