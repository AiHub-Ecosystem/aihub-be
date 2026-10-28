export function deprecationDateErrors(
  routeId: string,
  dates: { deprecationAt: string; sunsetAt: string },
  now = Date.now(),
): string[] {
  const deprecationTime = Date.parse(dates.deprecationAt);
  const sunsetTime = Date.parse(dates.sunsetAt);
  const errors: string[] = [];

  if (Number.isNaN(deprecationTime)) {
    errors.push(`${routeId}: deprecationAt is not a valid date.`);
  }
  if (Number.isNaN(sunsetTime)) {
    errors.push(`${routeId}: sunsetAt is not a valid date.`);
  } else if (sunsetTime < now) {
    errors.push(
      `${routeId}: sunsetAt is in the past without the route being marked removed.`,
    );
  }
  if (
    !Number.isNaN(deprecationTime) &&
    !Number.isNaN(sunsetTime) &&
    sunsetTime < deprecationTime
  ) {
    errors.push(`${routeId}: sunsetAt is earlier than deprecationAt.`);
  }

  return errors;
}
