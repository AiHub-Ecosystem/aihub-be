import { createHash } from 'node:crypto';

import { invalidRequest } from '@/common/errors/invalid-request';
import { isRecord } from '@/common/is-record';
import { canonicalJson } from '@/common/serialization/canonical-json';

export const CURSOR_VERSION = 1;
const SCOPE_HASH_LENGTH = 16;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface CursorPayload<TPosition> {
  readonly v: number;
  readonly pos: TPosition;
  readonly s: string;
}

export type CursorScope = Readonly<Record<string, unknown>>;

export function computeScopeHash(scope: CursorScope): string {
  return createHash('sha256')
    .update(canonicalJson(scope))
    .digest('hex')
    .slice(0, SCOPE_HASH_LENGTH);
}

export function encodeCursor<TPosition>(
  position: TPosition,
  scope: CursorScope,
): string {
  const payload: CursorPayload<TPosition> = {
    v: CURSOR_VERSION,
    pos: position,
    s: computeScopeHash(scope),
  };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export type CursorDecodeResult<TPosition> =
  | { readonly kind: 'ok'; readonly position: TPosition }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'stale'; readonly reason: string }
  | { readonly kind: 'mismatched'; readonly reason: string };

export function tryDecodeCursor<TPosition>(
  raw: string,
  scope: CursorScope,
  isPosition: (value: unknown) => value is TPosition,
): CursorDecodeResult<TPosition> {
  if (raw.trim().length === 0) {
    return { kind: 'malformed', reason: 'Cursor must be a non-empty string' };
  }

  if (!BASE64URL_PATTERN.test(raw)) {
    return { kind: 'malformed', reason: 'Cursor contains invalid characters' };
  }

  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return { kind: 'malformed', reason: 'Cursor is not valid JSON' };
  }

  if (!isRecord(parsed)) {
    return { kind: 'malformed', reason: 'Cursor payload is not an object' };
  }

  const { v, pos, s } = parsed;

  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return {
      kind: 'malformed',
      reason: 'Cursor version is missing or invalid',
    };
  }

  if (v !== CURSOR_VERSION) {
    return { kind: 'stale', reason: `Cursor version ${v} is not supported` };
  }

  if (typeof s !== 'string' || s.length !== SCOPE_HASH_LENGTH) {
    return {
      kind: 'malformed',
      reason: 'Cursor scope hash is missing or invalid',
    };
  }

  const expectedHash = computeScopeHash(scope);
  if (s !== expectedHash) {
    return {
      kind: 'mismatched',
      reason: 'Cursor does not match the requested scope',
    };
  }

  if (!isPosition(pos)) {
    return { kind: 'malformed', reason: 'Cursor position is invalid' };
  }

  return { kind: 'ok', position: pos };
}

export function decodeCursor<TPosition>(
  raw: string,
  scope: CursorScope,
  isPosition: (value: unknown) => value is TPosition,
): TPosition {
  const result = tryDecodeCursor(raw, scope, isPosition);
  if (result.kind !== 'ok') {
    throw invalidRequest(
      undefined,
      { cursor: result.reason },
      `Cursor decode failed: ${result.kind} (${result.reason})`,
    );
  }
  return result.position;
}
