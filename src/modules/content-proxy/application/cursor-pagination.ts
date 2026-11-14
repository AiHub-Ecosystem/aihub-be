import { invalidRequest } from '@/common/errors/invalid-request';

export interface CursorPayload {
  readonly page: number;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor?: string): CursorPayload {
  if (cursor === undefined) return { page: 1 };
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'page' in parsed &&
      typeof (parsed as { page: unknown }).page === 'number' &&
      Number.isInteger((parsed as { page: number }).page) &&
      (parsed as { page: number }).page >= 1
    ) {
      return { page: (parsed as { page: number }).page };
    }
  } catch {}
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
