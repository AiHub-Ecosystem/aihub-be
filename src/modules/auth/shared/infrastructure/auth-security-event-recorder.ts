import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  type AuthSecurityEvent,
  type AuthSecurityEventRecorderPort,
} from '@/modules/auth/shared/application/auth-security-event.port';
import { incrementAuthSecurityEvent } from './auth-security-event-metric';

@Injectable()
export class AuthSecurityEventRecorder
  implements AuthSecurityEventRecorderPort
{
  constructor(private readonly logger: PinoLogger) {}

  record(event: AuthSecurityEvent): void {
    incrementAuthSecurityEvent(event.event);

    const fields: Record<string, string | number> = {
      event: event.event,
      occurred_at: event.occurredAt.toISOString(),
    };
    if ('userAccountId' in event) {
      fields['user_account_id'] = event.userAccountId;
    }
    if (event.event === 'web_session_created') {
      fields['source'] = event.source;
    }
    if (event.event === 'web_session_revoked') {
      fields['trigger'] = event.trigger;
      fields['sessions_revoked'] = event.sessionsRevoked;
    }

    this.logger.info(fields, 'auth_security_event');
  }
}
