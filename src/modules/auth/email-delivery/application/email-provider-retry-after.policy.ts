/** Provider throttling without a Retry-After header uses this bounded delay. */
export const EMAIL_PROVIDER_RATE_LIMIT_RETRY_MS = 60_000;

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
  /^(?<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?<day>\d{2}) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<year>\d{4}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) GMT$/,
  /^(?<weekday>Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?<day>\d{2})-(?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(?<shortYear>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) GMT$/,
  /^(?<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<day>\d{2}| \d) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) (?<year>\d{4})$/,
];

function parseHttpDate(value: string, now: Date): number | undefined {
  const groups = HTTP_DATE_PATTERNS.map(
    (pattern) => pattern.exec(value)?.groups,
  ).find((candidate) => candidate !== undefined);
  if (groups === undefined) return undefined;

  const month = HTTP_DATE_MONTHS.indexOf(groups.month ?? '');
  const weekday = HTTP_DATE_WEEKDAYS.indexOf(
    (groups.weekday ?? '').slice(0, 3),
  );
  let year =
    groups.year === undefined
      ? Math.floor(now.getUTCFullYear() / 100) * 100 + Number(groups.shortYear)
      : Number(groups.year);

  const day = Number(groups.day);
  const hour = Number(groups.hour);
  const minute = Number(groups.minute);
  const second = Number(groups.second);
  if (month < 0 || weekday < 0 || hour > 23 || minute > 59 || second > 60) {
    return undefined;
  }

  const timestampForYear = (candidateYear: number): number => {
    const date = new Date(0);
    date.setUTCFullYear(candidateYear, month, day);
    date.setUTCHours(hour, minute, Math.min(second, 59));
    return date.getTime() + (second === 60 ? 1_000 : 0);
  };
  let timestamp = timestampForYear(year);
  if (groups.shortYear !== undefined) {
    const fiftyYearsFromNow = new Date(now);
    fiftyYearsFromNow.setUTCFullYear(now.getUTCFullYear() + 50);
    if (timestamp > fiftyYearsFromNow.getTime()) {
      year -= 100;
      timestamp = timestampForYear(year);
    }
  }

  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
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

export function emailProviderRetryAfterMs(
  value: string | undefined,
  now: Date,
): number {
  if (value === undefined) return EMAIL_PROVIDER_RATE_LIMIT_RETRY_MS;

  const header = value.trim();
  if (header.length === 0) return EMAIL_PROVIDER_RATE_LIMIT_RETRY_MS;
  const maximumDateDelay = 8_640_000_000_000_000 - now.getTime();
  if (/^\d+$/.test(header)) {
    const delay = Number(header) * 1_000;
    return Number.isFinite(delay)
      ? Math.min(delay, maximumDateDelay)
      : maximumDateDelay;
  }

  const retryAt = parseHttpDate(header, now);
  return retryAt !== undefined
    ? Math.max(0, Math.min(retryAt - now.getTime(), maximumDateDelay))
    : EMAIL_PROVIDER_RATE_LIMIT_RETRY_MS;
}
