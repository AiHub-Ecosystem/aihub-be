#!/usr/bin/env node
/**
 * Re-fetches an AI service's published OpenAPI document into the snapshot the
 * contract drift check reads (test/provider-contract-drift.spec.ts).
 *
 *   bun run provider:refresh            every service listed below
 *   bun run provider:refresh speaking   one of them
 *
 * The snapshot is written with sorted keys, so a refresh changes it only when
 * the provider's contract changed; the weekly workflow relies on that. After a
 * change, read the diff, then run the drift spec: a new difference from
 * AIHUB's schema either needs a schema change here or an entry, with its
 * reason, in the service's allowed-drift file.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PROVIDERS = {
  speaking: {
    url: 'https://api-ielts-speaking.aihubproduction.com/openapi.json',
    file: '../../test/fixtures/ai-speaking/provider-openapi.snapshot.json',
  },
  // AI Writing publishes an OpenAPI document, but declares an empty response
  // schema for every grading endpoint, so there is nothing to compare against.
};

/** @typedef {keyof typeof PROVIDERS} ProviderName */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {unknown} */
function sorted(value) {
  if (Array.isArray(value)) {
    return /** @type {unknown[]} */ (value).map(sorted);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  }
  return value;
}

/** @param {string} name @returns {name is ProviderName} */
function isProviderName(name) {
  return Object.hasOwn(PROVIDERS, name);
}

/** @param {ProviderName} name @returns {Promise<void>} */
async function refresh(name) {
  const provider = PROVIDERS[name];
  const response = await fetch(provider.url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${name}: ${provider.url} answered ${response.status}`);
  }
  const document = /** @type {unknown} */ (await response.json());
  await writeFile(
    new URL(provider.file, import.meta.url),
    `${JSON.stringify(sorted(document), null, 2)}\n`,
  );
  console.log(
    `${name}: wrote ${fileURLToPath(new URL(provider.file, import.meta.url))}`,
  );
}

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(PROVIDERS);
const unknownName = names.find((name) => !isProviderName(name));
if (unknownName !== undefined) {
  console.error(
    `unknown service "${unknownName}"; expected one of ${Object.keys(PROVIDERS).join(', ')}`,
  );
  process.exit(2);
}

try {
  for (const name of names.filter(isProviderName)) {
    await refresh(name);
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '',
  );
  process.exit(1);
}
