import { invalidRequest } from '@/common/errors/invalid-request';
import { isRecord } from '@/common/is-record';

export interface CursorPayload {
  readonly page: number;
  readonly limit: number;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(
  cursor: string | undefined,
  currentLimit: number,
): { readonly page: number } {
  if (cursor === undefined) return { page: 1 };
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      typeof parsed['page'] === 'number' &&
      typeof parsed['limit'] === 'number' &&
      Number.isInteger(parsed['page']) &&
      parsed['page'] >= 1
    ) {
      if (parsed['limit'] !== currentLimit) {
        throw invalidRequest('Cursor cannot be reused with a different limit');
      }
      return { page: parsed['page'] };
    }
  } catch (error) {
    if (isRecord(error) && error['code'] === 'INVALID_REQUEST') {
      throw error;
    }
  }
  throw invalidRequest('Invalid cursor');
}

export function parseLimit(
  raw?: string,
  defaultLimit = 20,
  maxLimit = 200,
): number {
  if (raw === undefined) return defaultLimit;
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < 1 || num > maxLimit) {
    throw invalidRequest(`limit must be an integer between 1 and ${maxLimit}`);
  }
  return num;
}
