import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The release gate refuses any breaking change to a supported major. This is the
// one narrow way past it: the owner accepts specific changes, by their exact
// text, for exactly one base-to-candidate version pair, and names the ADR that
// records why. An entry that no longer matches what the gate finds fails, so the
// file cannot keep excusing a change that was reverted or reworded.
export const ACCEPTED_BREAKING_CHANGES_FILE =
  'scripts/ci/api-compatibility/accepted-breaking-changes.json';

/** @typedef {{text: string}} ApiChange */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {string} candidateRoot @returns {unknown[]} */
export function loadAcceptedBreakingChanges(candidateRoot) {
  const path = join(candidateRoot, ACCEPTED_BREAKING_CHANGES_FILE);
  if (!existsSync(path)) return [];
  const value = /** @type {unknown} */ (JSON.parse(readFileSync(path, 'utf8')));
  if (!Array.isArray(value)) {
    throw new Error(`${ACCEPTED_BREAKING_CHANGES_FILE} must be a list`);
  }
  return value;
}

/**
 * @param {{
 *   accepted: unknown[],
 *   candidateRoot: string,
 *   major: number,
 *   baseVersion: unknown,
 *   candidateVersion: string,
 *   breaks: ApiChange[],
 * }} input
 * @returns {ApiChange[]} the breaking changes nobody accepted
 */
export function withoutAcceptedBreaks({
  accepted,
  candidateRoot,
  major,
  baseVersion,
  candidateVersion,
  breaks,
}) {
  const entries = accepted.filter(
    (entry) =>
      isRecord(entry) &&
      entry.major === major &&
      entry.baseVersion === baseVersion &&
      entry.candidateVersion === candidateVersion,
  );
  if (entries.length === 0) return breaks;

  /** @type {Set<string>} */
  const allowed = new Set();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const label = `${ACCEPTED_BREAKING_CHANGES_FILE} /v${major} ${candidateVersion}`;
    if (
      typeof entry.decision !== 'string' ||
      !existsSync(join(candidateRoot, entry.decision))
    ) {
      throw new Error(`${label} must name an existing decision record`);
    }
    if (
      !Array.isArray(entry.changes) ||
      entry.changes.length === 0 ||
      !entry.changes.every((change) => typeof change === 'string')
    ) {
      throw new Error(`${label} must list the accepted changes by their text`);
    }
    for (const change of entry.changes) allowed.add(String(change));
  }

  const found = new Set(breaks.map((change) => change.text));
  for (const text of allowed) {
    if (!found.has(text)) {
      throw new Error(
        `Accepted breaking change no longer occurs in /v${major} ${candidateVersion}: ${text}`,
      );
    }
  }
  return breaks.filter((change) => !allowed.has(change.text));
}
