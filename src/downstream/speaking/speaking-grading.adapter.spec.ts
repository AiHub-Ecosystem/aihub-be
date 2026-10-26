import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import {
  parseSpeakingGradingError,
  requiredSpeakingUserId,
} from './speaking-grading.adapter';

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-speaking');

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw');
}

function capture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

function context(userId?: string) {
  return createRequestContext({
    requestId: 'req_01M2MNRPCGCT96P54KDBE82MH7',
    receivedAt: new Date(),
    deadlineMs: 5_000,
    organizationId: 'org_acme',
    ...(userId === undefined ? {} : { userId }),
    scopes: [],
  });
}

describe('requiredSpeakingUserId', () => {
  it('returns the End-User ID exactly as resolved', () => {
    expect(requiredSpeakingUserId(context('Student@Example.COM'))).toBe(
      'Student@Example.COM',
    );
  });

  it.each([
    ['missing', undefined],
    ['blank', '  '],
  ])(
    'rejects a %s End-User ID before a downstream request exists',
    (_name, userId) => {
      expect(
        captureError(() => requiredSpeakingUserId(context(userId))),
      ).toMatchObject({ code: 'USER_IDENTITY_REQUIRED' });
    },
  );
});

describe('parseSpeakingGradingError', () => {
  it('names the captured unreadable-audio failure as a non-retryable client error', () => {
    const hint = parseSpeakingGradingError(
      500,
      capture('grading-convert-audio.500.json'),
    );

    expect(hint).toMatchObject({
      code: 'AUDIO_UNREADABLE',
      retryable: false,
    });
    expect(typeof hint?.message).toBe('string');
    expect(hint?.message).not.toContain('error_convert_audio');
  });

  it('names only a code the operation catalog publishes for this route', () => {
    const hint = parseSpeakingGradingError(
      500,
      capture('grading-convert-audio.500.json'),
    );

    expect(
      OPERATION_CATALOG['speaking.grading'].namedDownstreamErrors,
    ).toContain(hint?.code);
  });

  it.each([
    [
      'a 500 without the marker',
      500,
      { detail: 'Grading pipeline failed: [error_database] write failed' },
    ],
    [
      'the captured empty-audio 400',
      400,
      capture('grading-empty-audio.400.json'),
    ],
    [
      'the marker on a non-5xx status',
      400,
      capture('grading-convert-audio.500.json'),
    ],
    ['a body that is not JSON', 500, undefined],
    ['a detail that is not text', 500, { detail: ['[error_convert_audio]'] }],
  ])('leaves %s to the status mapping', (_name, status, body) => {
    expect(parseSpeakingGradingError(status, body)).toBeUndefined();
  });
});
