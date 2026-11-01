import { isRecord } from '@/common/is-record';
import type { DownstreamErrorHint } from '@/downstream/downstream.types';

const TIMEOUT: DownstreamErrorHint = {
  code: 'AI_SERVICE_TIMEOUT',
  message: 'AI service request timed out',
  retryable: true,
};

const REFUSED_INPUT: DownstreamErrorHint = {
  code: 'INVALID_REQUEST',
  message: 'Writing request was refused by the AI service',
  retryable: false,
};

/**
 * Names the provider failures a customer can act on or that are a timeout
 * (ADR-0143 decision 12). It reads the body `error_code` (shape in the
 * provider document, section 2.2) and never forwards the provider's text.
 * Everything else, including a missing or malformed `X-AIHUB-*` header (AIHUB's
 * own fault), 401, 429 and 5xx, returns `undefined` and takes the dispatcher's
 * status mapping, which keeps 429's `Retry-After`.
 */
export function parseWritingV3ProviderError(
  status: number,
  body: unknown,
): DownstreamErrorHint | undefined {
  if (status < 400) {
    return undefined;
  }
  if (status === 504) {
    return TIMEOUT;
  }
  if (!isRecord(body) || typeof body.error_code !== 'string') {
    return undefined;
  }
  switch (body.error_code) {
    case 'gateway_timeout':
      return TIMEOUT;
    case 'payload_too_large':
    case 'image_unreadable':
      return REFUSED_INPUT;
    default:
      return undefined;
  }
}
