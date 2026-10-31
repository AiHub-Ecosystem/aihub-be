import { Blob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { UserIdentityMode } from '@/common/request-context/request-context';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import { speakingGradingJsonAdapter } from './speaking-grading-json.adapter';
import {
  parseSpeakingGradingError,
  requiredSpeakingIdentityHeaders,
  requiredSpeakingUserId,
  speakingGradingAdapter,
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

function context(
  userId?: string,
  organizationId: string | null = 'org_acme',
  identityMode: UserIdentityMode | null = 'declared_id',
) {
  return createRequestContext({
    requestId: 'req_01M2MNRPCGCT96P54KDBE82MH7',
    receivedAt: new Date(),
    deadlineMs: 5_000,
    ...(organizationId === null ? {} : { organizationId }),
    ...(userId === undefined ? {} : { userId }),
    ...(identityMode === null ? {} : { identityMode }),
    scopes: [],
  });
}

const audio = {
  blob: new Blob(['synthetic audio']),
  filename: 'answer.wav',
  contentType: 'audio/wav',
};

function expectBothTransportsToReject(
  identity: ReturnType<typeof context>,
  code: string,
): void {
  const actions = [
    () =>
      speakingGradingAdapter.buildRequest(
        { audio, part: 1, questionId: 'q1' },
        identity,
      ),
    () =>
      speakingGradingJsonAdapter.buildRequest(
        {
          audioUrl: 'https://s3.wispace.app/audio.wav',
          part: 1,
          questionId: 'q1',
        },
        identity,
      ),
  ];
  for (const action of actions) {
    expect(captureError(action)).toMatchObject({ code });
  }
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

describe('Speaking identity headers', () => {
  it('changes only the Organization header when the same End-User belongs to another Organization', () => {
    const first = requiredSpeakingIdentityHeaders(
      context('same-user', 'org_first'),
    );
    const second = requiredSpeakingIdentityHeaders(
      context('same-user', 'org_second'),
    );

    expect(second).toEqual({
      ...first,
      'x-aihub-organization-id': 'org_second',
    });
  });

  it.each(['declared_id', 'signed_assertion'] satisfies UserIdentityMode[])(
    'forwards the resolved %s identity mode',
    (identityMode) => {
      expect(
        requiredSpeakingIdentityHeaders(
          context('same-user', 'org_first', identityMode),
        )['x-aihub-user-identity-mode'],
      ).toBe(identityMode);
    },
  );

  it('fails closed for a missing Organization on both transports', () => {
    expect.assertions(2);
    expectBothTransportsToReject(context('same-user', null), 'INTERNAL_ERROR');
  });

  it('fails closed for a blank Organization on both transports', () => {
    expect.assertions(2);
    expectBothTransportsToReject(context('same-user', '  '), 'INTERNAL_ERROR');
  });

  it('fails closed for a missing End-User ID on both transports', () => {
    expect.assertions(2);
    expectBothTransportsToReject(
      context(undefined, 'org_first'),
      'USER_IDENTITY_REQUIRED',
    );
  });

  it('fails closed for a blank End-User ID on both transports', () => {
    expect.assertions(2);
    expectBothTransportsToReject(
      context('  ', 'org_first'),
      'USER_IDENTITY_REQUIRED',
    );
  });

  it('fails closed for a missing identity mode on both transports', () => {
    expect.assertions(2);
    expectBothTransportsToReject(
      context('same-user', 'org_first', null),
      'INTERNAL_ERROR',
    );
  });
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
