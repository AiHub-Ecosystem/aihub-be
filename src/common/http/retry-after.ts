const MAX_DATE_MS = 8_640_000_000_000_000;

const HTTP_DATE_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const HTTP_DATE_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HTTP_DATE_PATTERNS = [
  /^(?<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?<day>\d{2}) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<year>\d{4}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) GMT$/u,
  /^(?<weekday>Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?<day>\d{2})-(?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(?<shortYear>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) GMT$/u,
  /^(?<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<day>\d{2}| \d) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) (?<year>\d{4})$/u,
];

function httpDateMs(value: string, now: Date): number | undefined {
  const groups = HTTP_DATE_PATTERNS.map(
    (pattern) => pattern.exec(value)?.groups,
  ).find((candidate) => candidate !== undefined);
  if (groups === undefined) return undefined;

  const month = HTTP_DATE_MONTHS.indexOf(groups['month'] ?? '');
  const weekday = HTTP_DATE_WEEKDAYS.indexOf(
    (groups['weekday'] ?? '').slice(0, 3),
  );
  const year =
    groups['year'] === undefined
      ? Math.floor(now.getUTCFullYear() / 100) * 100 +
        Number(groups['shortYear'])
      : Number(groups['year']);
  const day = Number(groups['day']);
  const hour = Number(groups['hour']);
  const minute = Number(groups['minute']);
  const second = Number(groups['second']);
  if (month < 0 || weekday < 0 || hour > 23 || minute > 59 || second > 60) {
    return undefined;
  }

  const timestampForYear = (candidateYear: number): number => {
    const date = new Date(0);
    date.setUTCFullYear(candidateYear, month, day);
    date.setUTCHours(hour, minute, Math.min(second, 59));
    return date.getTime() + (second === 60 ? 1_000 : 0);
  };
  let resolvedYear = year;
  let timestamp = timestampForYear(resolvedYear);
  if (groups['shortYear'] !== undefined) {
    const fiftyYearsFromNow = new Date(now);
    fiftyYearsFromNow.setUTCFullYear(now.getUTCFullYear() + 50);
    if (timestamp > fiftyYearsFromNow.getTime()) {
      resolvedYear -= 100;
      timestamp = timestampForYear(resolvedYear);
    }
  }

  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== resolvedYear ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCDay() !== weekday
  ) {
    return undefined;
  }

  return timestamp;
}

/**
 * One RFC 9110 `Retry-After` parser for the gateway and the email outbox.
 * `now` is injected so both consumers measure the same header the same way.
 */
export function parseRetryAfter(
  header: string | undefined,
  now: Date,
): number | undefined {
  if (header === undefined) return undefined;
  const value = header.trim();
  if (value.length === 0) return undefined;
  const maximum = MAX_DATE_MS - now.getTime();
  if (/^\d+$/u.test(value)) {
    const delay = Number(value) * 1_000;
    return Math.min(Number.isFinite(delay) ? delay : maximum, maximum);
  }

  const timestamp = httpDateMs(value, now);
  return timestamp === undefined
    ? undefined
    : Math.min(Math.max(0, timestamp - now.getTime()), maximum);
}
