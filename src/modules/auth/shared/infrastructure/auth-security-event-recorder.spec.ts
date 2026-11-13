import { ContextIdFactory } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
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

const EVENT_LOG_RECORD = Type.Record(Type.String(), Type.Unknown());

/** Builds a deterministic event fixture for each supported security-event name. */
function eventFor(event: AuthSecurityEventName): AuthSecurityEvent {
  switch (event) {
    case 'login_failed':
      return { event, occurredAt: OCCURRED_AT, userAccountId: USER_ID };
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
    logger.logger.level = 'info';
    await moduleRef.close();
  });

  it('keeps the issue-approved event names as the complete fixed set', () => {
    expect(AUTH_SECURITY_EVENT_NAMES).toEqual([
      'refresh_reuse',
      'password_reset_completed',
      'login_succeeded',
      'login_failed',
      'verification_sign_in',
    ]);
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
    const records = lines.map((line) => {
      const parsed: unknown = JSON.parse(line);
      return Value.Parse(EVENT_LOG_RECORD, parsed);
    });
    expect(records.map((line) => line['event'])).toEqual(
      AUTH_SECURITY_EVENT_NAMES,
    );
    for (const line of records) {
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

  it.each(['warn', 'error', 'fatal', 'silent'] as const)(
    'emits security events at %s without lowering the configured logger level',
    async (logLevel) => {
      logger.logger.level = logLevel;
      lines = [];
      logger.runInContext(
        () => {
          recorder.record({
            event: 'login_succeeded',
            userAccountId: USER_ID,
            occurredAt: OCCURRED_AT,
          });
          logger.info({ event: 'ordinary_auth_log' }, 'ordinary_auth_log');
        },
        { bindings: { request_id: REQUEST_ID }, inherit: true },
      );

      expect(logger.logger.level).toBe(logLevel);
      expect(lines).toHaveLength(1);
      const raw: unknown = JSON.parse(lines[0] ?? 'null');
      const parsed = Value.Parse(EVENT_LOG_RECORD, raw);
      expect(parsed).toMatchObject({
        level: 'info',
        event: 'login_succeeded',
        request_id: REQUEST_ID,
        user_account_id: USER_ID,
      });
    },
  );

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
