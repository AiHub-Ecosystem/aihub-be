/**
 * Parses a canonical UTC instant, rejecting anything that is not one.
 *
 * The round trip through `toISOString` is what carries the weight. A pattern
 * match alone accepts `2026-02-30T00:00:00Z`, which the platform then rolls
 * forward into March rather than refusing, so a window built from it would be
 * silently different from the one that was asked for. Re-rendering the parsed
 * value and comparing it against the input catches exactly that.
 *
 * Failure is a return value rather than a raised error: this is used by a CLI
 * that reports an invalid window and by an HTTP boundary that answers
 * `INVALID_REQUEST`, and neither error belongs to the other.
 */
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export function parseUtcTimestamp(raw: string): Date | undefined {
  const match = UTC_TIMESTAMP_PATTERN.exec(raw);
  if (match === null) {
    return undefined;
  }

  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    return undefined;
  }

  // A short fractional component is canonical input but renders padded, so it
  // is padded here too rather than being failed by the comparison below.
  const milliseconds = (match[7] ?? '').padEnd(3, '0');
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds || '000'}Z`;
  if (value.toISOString() !== canonical) {
    return undefined;
  }

  return value;
}
