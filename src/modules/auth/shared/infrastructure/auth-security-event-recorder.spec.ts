import { ContextIdFactory } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { LoggerModule, PinoLogger } from 'nestjs-pino';

import { getMetrics, registry } from '@/common/observability/metrics';
import {
  type RequestLogStream,
  createNestPinoOptions,
} from '@/common/observability/request-logger';
import {
  AUTH_SECURITY_EVENT_NAMES,
  type AuthSecurityEvent,
  type AuthSecurityEventName,
} from '@/modules/auth/shared/application/auth-security-event.port';
import { AuthSecurityEventRecorder } from './auth-security-event-recorder';

const USER_ID = 'usr_01J00000000000000000000000';
const REQUEST_ID = 'req_01J00000000000000000000000';
const OCCURRED_AT = new Date('2026-11-11T12:00:00.000Z');
const FORBIDDEN_PROPERTIES = {
  email: 'person@example.com',
  password: 'password-sentinel',
  token: 'raw-token-sentinel',
  token_hash: 'token-hash-sentinel',
  cookie: 'cookie-sentinel',
  raw_ip: '203.0.113.17',
  request_body: 'request-body-sentinel',
};
const FORBIDDEN_VALUES = Object.values(FORBIDDEN_PROPERTIES);

function eventFor(event: AuthSecurityEventName): AuthSecurityEvent {
  switch (event) {
    case 'login_failed':
      return { event, occurredAt: OCCURRED_AT, userAccountId: USER_ID };
    case 'web_session_exchange_refused_unknown':
      return { event, occurredAt: OCCURRED_AT };
    case 'web_session_client_secret_guard_failed':
      return { event, occurredAt: OCCURRED_AT };
    case 'web_session_created':
      return {
        event,
        occurredAt: OCCURRED_AT,
        source: 'password_login',
        userAccountId: USER_ID,
      };
    case 'web_session_revoked':
      return {
        event,
        occurredAt: OCCURRED_AT,
        sessionsRevoked: 2,
        trigger: 'password_reset',
        userAccountId: USER_ID,
      };
    case 'web_session_exchange_refused_expired':
    case 'web_session_exchange_refused_revoked':
    case 'web_session_exchange_refused_inactive_account':
    case 'refresh_reuse':
    case 'password_reset_completed':
    case 'login_succeeded':
    case 'verification_sign_in':
      return { event, occurredAt: OCCURRED_AT, userAccountId: USER_ID };
  }
}

function includeForbiddenProperties(
  event: AuthSecurityEvent,
): AuthSecurityEvent {
  const unsafeEvent = { ...event, ...FORBIDDEN_PROPERTIES };
  return unsafeEvent;
}

describe('Auth security event recorder', () => {
  let moduleRef: TestingModule;
  let recorder: AuthSecurityEventRecorder;
  let logger: PinoLogger;
  let lines: string[];

  beforeEach(async () => {
    registry.resetMetrics();
    lines = [];
    const stream: RequestLogStream = {
      write(line) {
        lines.push(line.trim());
      },
    };
    moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot(createNestPinoOptions('info', stream))],
      providers: [AuthSecurityEventRecorder],
    }).compile();
    const contextId = ContextIdFactory.create();
    moduleRef.registerRequestByContextId({}, contextId);
    recorder = await moduleRef.resolve(AuthSecurityEventRecorder, contextId);
    logger = await moduleRef.resolve(PinoLogger, contextId);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('writes one bounded JSON event line and increments one fixed series per event', async () => {
    logger.runInContext(
      () => {
        for (const event of AUTH_SECURITY_EVENT_NAMES) {
          recorder.record(includeForbiddenProperties(eventFor(event)));
        }
      },
      { bindings: { request_id: REQUEST_ID }, inherit: true },
    );

    expect(lines).toHaveLength(AUTH_SECURITY_EVENT_NAMES.length);
    const parsed = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(parsed.map((line) => line['event'])).toEqual(
      AUTH_SECURITY_EVENT_NAMES,
    );
    for (const line of parsed) {
      expect(line).toMatchObject({
        occurred_at: OCCURRED_AT.toISOString(),
        request_id: REQUEST_ID,
      });
      expect(
        Object.keys(line).filter((key) =>
          [
            'event',
            'occurred_at',
            'request_id',
            'user_account_id',
            'source',
            'trigger',
            'sessions_revoked',
            'level',
            'time',
            'pid',
            'hostname',
            'msg',
          ].includes(key),
        ),
      ).toHaveLength(Object.keys(line).length);
    }

    const metrics = await getMetrics();
    const series = metrics
      .split('\n')
      .filter((line) => line.startsWith('aihub_auth_security_events_total{'));
    expect(series).toHaveLength(AUTH_SECURITY_EVENT_NAMES.length);
    for (const event of AUTH_SECURITY_EVENT_NAMES) {
      expect(series).toContain(
        `aihub_auth_security_events_total{event="${event}"} 1`,
      );
    }

    const output = `${lines.join('\n')}\n${series.join('\n')}`;
    for (const value of FORBIDDEN_VALUES) {
      expect(output).not.toContain(value);
    }
    expect(
      series.every((line) =>
        /^aihub_auth_security_events_total\{event="[a-z_]+"\} \d+$/.test(line),
      ),
    ).toBe(true);
  });

  it('rejects an event outside the fixed set without adding a metric series', async () => {
    expect(() =>
      recorder.record({
        event: 'unmapped_event',
        occurredAt: OCCURRED_AT,
      } as never),
    ).toThrow(/unmapped Auth security event/);

    expect(lines).toHaveLength(0);
    expect(await getMetrics()).not.toContain('unmapped_event');
  });
});
