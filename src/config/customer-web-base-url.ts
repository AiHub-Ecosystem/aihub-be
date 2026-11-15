/**
 * The one rule for the Customer Web base URL that account emails link to: an
 * absolute http(s) URL (https only when `requireHttps`) with a host and no
 * credentials, query, or fragment. Startup configuration validation and the
 * email composer both ask it, so the value the configuration accepts is the
 * value the sender builds links from.
 *
 * Returns the URL without a trailing slash, or `undefined` when the value is
 * blank or breaks the rule.
 */
export function parseCustomerWebBaseUrl(
  value: string,
  requireHttps: boolean,
): string | undefined {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    (requireHttps && parsed.protocol !== 'https:')
  ) {
    return undefined;
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}
