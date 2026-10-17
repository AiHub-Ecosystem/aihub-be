import { FormatRegistry } from '@sinclair/typebox';

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether `value` is an RFC 3339 timestamp naming a real calendar moment.
 * `Date.parse` alone rolls an impossible day or hour forward instead of
 * refusing it: `2026-02-30` reads as 2 March and `T24:00` as the next day.
 */
export function isDateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day, hour] = match.slice(1, 5).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined
  ) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth && hour <= 23;
}

// TypeBox rejects an unregistered format outright, so `date-time` is taught
// once here, and every contract that uses it imports this module.
if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set('date-time', isDateTime);
}
