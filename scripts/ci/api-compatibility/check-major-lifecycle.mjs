import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = /^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STATUSES = new Set(['supported', 'retired']);

/** @typedef {{successor: number, deprecationAt: string, sunsetAt: string}} MajorSunset */
/** @typedef {{major: number, contractVersion: string, status: 'supported' | 'retired', releasedAt: string, sunset?: MajorSunset}} MajorEntry */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {unknown} value @param {string} label @returns {number} */
function instant(value, label) {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time)) throw new Error(`${label} is not an ISO 8601 date`);
  return time;
}

/** @param {unknown} value @param {string} label @returns {MajorEntry} */
function parseEntry(value, label) {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  const { major, contractVersion, status, releasedAt, sunset } = value;
  if (typeof major !== 'number' || !Number.isSafeInteger(major) || major < 1) {
    throw new Error(`${label}.major must be a positive integer`);
  }
  const version =
    typeof contractVersion === 'string' ? VERSION.exec(contractVersion) : null;
  if (!version || Number(version[1]) !== major) {
    throw new Error(
      `${label}.contractVersion must be SemVer at major ${major}`,
    );
  }
  if (typeof status !== 'string' || !STATUSES.has(status)) {
    throw new Error(`${label}.status must be supported or retired`);
  }
  instant(releasedAt, `${label}.releasedAt`);
  if (sunset !== undefined) {
    if (!isRecord(sunset) || typeof sunset.successor !== 'number') {
      throw new Error(`${label}.sunset needs a successor major`);
    }
    const deprecation = instant(
      sunset.deprecationAt,
      `${label}.sunset.deprecationAt`,
    );
    if (deprecation > instant(sunset.sunsetAt, `${label}.sunset.sunsetAt`)) {
      throw new Error(`${label}.sunset.deprecationAt is after its sunsetAt`);
    }
  } else if (status === 'retired') {
    throw new Error(`${label} is retired without a sunset`);
  }
  return /** @type {MajorEntry} */ (value);
}

/** @param {string} root @returns {MajorEntry[] | undefined} */
function readMajors(root) {
  const path = join(root, 'openapi', 'majors.json');
  if (!existsSync(path)) return undefined;
  const value = /** @type {unknown} */ (JSON.parse(readFileSync(path, 'utf8')));
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  const entries = value.map((entry, index) =>
    parseEntry(entry, `openapi/majors.json[${index}]`),
  );
  if (new Set(entries.map((entry) => entry.major)).size !== entries.length) {
    throw new Error('openapi/majors.json lists a major twice');
  }
  return entries;
}

/** @param {number} time @returns {number} */
function twelveMonthsAfter(time) {
  const date = new Date(time);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.getTime();
}

/**
 * ADR-0127's major lifecycle, checked from `openapi/majors.json` (generated
 * from `src/catalog/public-api-majors.ts`): which majors have a document, how
 * long a superseded major stays, that a published sunset never moves earlier,
 * and when a major's document may leave. Returns the majors whose document
 * this release may remove because it retires them.
 *
 * @param {string} baseRoot
 * @param {string} candidateRoot
 * @param {ReadonlyMap<number, {info: Record<string, unknown>}>} candidateSpecs
 * @param {ReadonlySet<number>} baseSpecMajors
 * @param {Date} today
 * @returns {Set<number>}
 */
export function checkMajorLifecycle(
  baseRoot,
  candidateRoot,
  candidateSpecs,
  baseSpecMajors,
  today,
) {
  const majors = readMajors(candidateRoot);
  if (!majors) throw new Error('Missing openapi/majors.json');
  const byMajor = new Map(majors.map((entry) => [entry.major, entry]));

  const supported = majors.filter((entry) => entry.status === 'supported');
  for (const entry of supported) {
    const document = candidateSpecs.get(entry.major);
    if (!document) {
      throw new Error(
        `Supported /v${entry.major} has no openapi/v${entry.major}.json`,
      );
    }
    if (document.info.version !== entry.contractVersion) {
      throw new Error(
        `openapi/v${entry.major}.json is ${String(document.info.version)} but openapi/majors.json says ${entry.contractVersion}`,
      );
    }
  }
  for (const major of candidateSpecs.keys()) {
    if (byMajor.get(major)?.status !== 'supported') {
      throw new Error(`openapi/v${major}.json is not a supported major`);
    }
  }

  const latest = Math.max(...supported.map((entry) => entry.major));
  for (const entry of majors) {
    if (entry.major === latest) {
      if (entry.sunset) {
        throw new Error(`The newest major /v${latest} cannot have a sunset`);
      }
      continue;
    }
    if (!entry.sunset) {
      throw new Error(`Superseded /v${entry.major} needs a published sunset`);
    }
    const successor = byMajor.get(entry.sunset.successor);
    if (!successor || successor.major <= entry.major) {
      throw new Error(`/v${entry.major} names no later successor major`);
    }
    if (
      Date.parse(entry.sunset.sunsetAt) <
      twelveMonthsAfter(Date.parse(successor.releasedAt))
    ) {
      throw new Error(
        `/v${entry.major} sunset must be at least 12 months after /v${successor.major} is released`,
      );
    }
  }

  for (const entry of readMajors(baseRoot) ?? []) {
    const candidate = byMajor.get(entry.major);
    if (!candidate) {
      throw new Error(
        `Candidate drops /v${entry.major} from openapi/majors.json`,
      );
    }
    if (entry.status === 'retired' && candidate.status !== 'retired') {
      throw new Error(`Retired /v${entry.major} cannot be supported again`);
    }
    if (
      entry.sunset &&
      (!candidate.sunset ||
        Date.parse(candidate.sunset.sunsetAt) <
          Date.parse(entry.sunset.sunsetAt))
    ) {
      throw new Error(
        `/v${entry.major} sunset can only move later than ${entry.sunset.sunsetAt}`,
      );
    }
  }

  /** @type {Set<number>} */
  const retiring = new Set();
  for (const major of baseSpecMajors) {
    const entry = byMajor.get(major);
    if (entry?.status !== 'retired' || !entry.sunset) continue;
    if (Date.parse(entry.sunset.sunsetAt) > today.getTime()) {
      throw new Error(
        `/v${major} cannot be retired before its sunset ${entry.sunset.sunsetAt}`,
      );
    }
    retiring.add(major);
  }
  return retiring;
}
