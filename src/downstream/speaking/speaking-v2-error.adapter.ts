import { isRecord } from '@/common/is-record';

import type { DownstreamErrorHint } from '@/downstream/downstream.types';

export function parseSpeakingV2ProviderError(
  body: unknown,
): DownstreamErrorHint | undefined {
  if (
    !isRecord(body) ||
    body['status'] !== 'error' ||
    body['usage'] !== null ||
    body['data'] !== null ||
    !isRecord(body['error']) ||
    typeof body['error']['code'] !== 'string'
  ) {
    return undefined;
  }
  switch (body['error']['code']) {
    case 'audio_unreadable':
      return {
        code: 'AUDIO_UNREADABLE',
        message: 'Speaking audio could not be decoded',
        retryable: false,
      };
    case 'not_found':
    case 'part_not_found':
    case 'response_not_found':
      return {
        code: 'NOT_FOUND',
        message: 'Speaking result was not found',
        retryable: false,
      };
    default:
      return undefined;
  }
}
