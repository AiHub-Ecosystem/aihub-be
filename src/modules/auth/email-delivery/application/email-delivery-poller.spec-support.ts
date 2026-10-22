import { EmailDeliveryPoller } from './email-delivery-poller';
import { EmailPayloadUnknownKeyVersionError } from './email-delivery-request.port';
import type {
  ClaimEmailDeliveryRequestsInput,
  EmailCredentialActionabilityPort,
  EmailCredentialState,
  EmailDeliveryErrorCode,
  EmailDeliveryKind,
  EmailDeliveryPayload,
  EmailDeliveryRequestRecord,
  EmailDispatchStorePort,
  EmailNoticeResolvers,
  EmailPayloadCipherPort,
  ReleaseUnspentEmailAttemptInput,
} from './email-delivery-request.port';
import type {
  EmailProviderOutageCircuitPort,
  EmailProviderSendPermit,
} from './email-provider-outage-circuit.port';
import type { EmailDailySendBudgetPort } from './email-send-daily-budget.port';
import type {
  EmailSendRateLimiterPort,
  EmailSendRateReservation,
} from './email-send-rate-limiter.port';
import type {
  EmailDispatchOptions,
  EmailMessage,
  EmailProviderResponse,
  EmailSenderPort,
} from './email-sender.port';

export const NOW = new Date('2026-10-05T12:00:00.000Z');
export const HOUR = 60 * 60 * 1000;
export const TOKEN = 'raw-opaque-token';
export const TOKEN_HASH = 'a'.repeat(64);
export const ROW_ID = 'edr_01J00000000000000000000000';
export const VERIFICATION_PAYLOAD = {
  email: 'person@example.com',
  token: TOKEN,
  expiresAt: new Date(NOW.getTime() + HOUR).toISOString(),
};

export class FakeStore implements EmailDispatchStorePort {
  claims: ClaimEmailDeliveryRequestsInput[] = [];
  claimResult: EmailDeliveryRequestRecord[] = [];
  accepted: string[] = [];
  cancelled: { id: string; reason: string }[] = [];
  failed: { id: string; errorCode: string }[] = [];
  attempts: { id: string; errorCode: string }[] = [];
  reserved: string[] = [];
  unspent: Pick<
    ReleaseUnspentEmailAttemptInput,
    'id' | 'previousAttempts' | 'previousAttemptAt' | 'retryAt'
  >[] = [];
  deferred: string[] = [];
  unreported: EmailDeliveryRequestRecord[] = [];
  exhausted: EmailDeliveryRequestRecord[] = [];
  reconcileLimits: number[] = [];
  reported: string[] = [];
  claimed: string[] = [];
  released: string[] = [];

  async claim(
    input: ClaimEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    this.claims.push(input);
    return this.claimResult.filter((request) => {
      const deferredAt = this.deferred.lastIndexOf(request.id);
      const retryAt =
        deferredAt < 0 ? undefined : this.deferredUntil[deferredAt];
      return retryAt === undefined || retryAt.getTime() <= input.now.getTime();
    });
  }

  async markProviderAccepted(input: { id: string }): Promise<void> {
    this.accepted.push(input.id);
  }

  async markCancelled(input: {
    id: string;
    reason: string;
  }): Promise<void> {
    this.cancelled.push({ id: input.id, reason: input.reason });
  }

  async markFailed(input: {
    id: string;
    errorCode: EmailDeliveryErrorCode;
  }): Promise<void> {
    this.failed.push({ id: input.id, errorCode: input.errorCode });
    const row = this.claimResult.find((claimed) => claimed.id === input.id);
    if (row !== undefined) {
      this.unreported.push({
        ...row,
        status: 'failed',
        lastErrorCode: input.errorCode,
      });
    }
  }

  async recordFailedAttempt(input: {
    id: string;
    errorCode: string;
  }): Promise<void> {
    this.attempts.push({ id: input.id, errorCode: input.errorCode });
  }

  async reserveAttempt(input: { id: string }): Promise<void> {
    this.reserved.push(input.id);
  }

  async releaseUnspentAttempt(
    input: ReleaseUnspentEmailAttemptInput,
  ): Promise<void> {
    this.unspent.push({
      id: input.id,
      previousAttempts: input.previousAttempts,
      previousAttemptAt: input.previousAttemptAt,
      retryAt: input.retryAt,
    });
    this.deferred.push(input.id);
    this.deferredUntil.push(input.retryAt);
  }

  deferredUntil: Date[] = [];
  stale: EmailDeliveryRequestRecord[] = [];
  staleCutoffs: {
    createdAtOrBefore: Date;
    kinds: readonly EmailDeliveryKind[];
  }[] = [];

  async releaseDeferred(input: { id: string; retryAt: Date }): Promise<void> {
    this.deferred.push(input.id);
    this.deferredUntil.push(input.retryAt);
  }

  async cancelStale(input: {
    createdAtOrBefore: Date;
    kinds: readonly EmailDeliveryKind[];
  }): Promise<readonly EmailDeliveryRequestRecord[]> {
    this.staleCutoffs.push({
      createdAtOrBefore: input.createdAtOrBefore,
      kinds: input.kinds,
    });
    return this.stale.filter((row) => input.kinds.includes(row.kind));
  }

  async failExhausted(): Promise<readonly EmailDeliveryRequestRecord[]> {
    this.unreported.push(...this.exhausted);
    return this.exhausted;
  }

  async claimUnreportedFailures(input: {
    limit: number;
  }): Promise<readonly EmailDeliveryRequestRecord[]> {
    this.reconcileLimits.push(input.limit);
    const claimed = this.unreported.slice(0, input.limit);
    this.claimed.push(...claimed.map((row) => row.id));
    return claimed;
  }

  async markFailureReported(input: { id: string }): Promise<void> {
    this.reported.push(input.id);
  }

  async releaseFailureNotification(input: { id: string }): Promise<void> {
    this.released.push(input.id);
  }
}

export class FakeCredentials implements EmailCredentialActionabilityPort {
  state: EmailCredentialState = 'actionable';
  checked: { kind: EmailDeliveryKind; tokenHash: string }[] = [];

  async check(input: {
    kind: EmailDeliveryKind;
    tokenHash: string;
    now: Date;
  }): Promise<EmailCredentialState> {
    this.checked.push({ kind: input.kind, tokenHash: input.tokenHash });
    return this.state;
  }
}

export interface RecordedSend {
  readonly message: EmailMessage;
  readonly idempotencyKey: string | undefined;
}

export class RecordingSender implements EmailSenderPort {
  sends: RecordedSend[] = [];
  failure: Error | undefined;
  response: EmailProviderResponse = {
    status: 202,
    retryAfter: undefined,
  };

  async send(
    message: EmailMessage,
    options?: EmailDispatchOptions,
  ): Promise<EmailProviderResponse> {
    this.sends.push({ message, idempotencyKey: options?.idempotencyKey });
    if (this.failure !== undefined) throw this.failure;
    return this.response;
  }
}

export class FakeEmailSendRateLimiter implements EmailSendRateLimiterPort {
  reservations = 0;
  result: EmailSendRateReservation = { reserved: true };
  failure: Error | undefined;

  async reserve(): Promise<EmailSendRateReservation> {
    this.reservations += 1;
    if (this.failure !== undefined) throw this.failure;
    return this.result;
  }
}

export class FakeEmailProviderOutageCircuit
  implements EmailProviderOutageCircuitPort
{
  permit: EmailProviderSendPermit = { allowed: true };
  readonly failures: number[] = [];
  readonly failedProbeTokens: (string | undefined)[] = [];
  readonly releases: string[] = [];
  reachable = 0;
  outageDurationMs = 0;
  cooldownMs = 5_000;

  async acquireSendPermit(): Promise<EmailProviderSendPermit> {
    return this.permit;
  }

  async releaseProbe(probeToken: string): Promise<void> {
    this.releases.push(probeToken);
  }

  async recordProviderFailure(
    retryAfterMs: number,
    probeToken?: string,
  ): Promise<number> {
    this.failures.push(retryAfterMs);
    this.failedProbeTokens.push(probeToken);
    return Math.max(this.cooldownMs, retryAfterMs);
  }

  async recordProviderReachable(): Promise<void> {
    this.reachable += 1;
  }

  async readOutageDurationMs(): Promise<number> {
    return this.outageDurationMs;
  }
}

export function claimed(
  overrides: Partial<EmailDeliveryRequestRecord> = {},
): EmailDeliveryRequestRecord {
  return {
    id: ROW_ID,
    kind: 'verification_email',
    status: 'queued',
    payloadCiphertext: 'sealed',
    attempts: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    cancelReason: null,
    createdAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

export function sealed(payload: EmailDeliveryPayload): EmailPayloadCipherPort {
  return {
    encrypt: (): string => 'sealed',
    decrypt: (): string => JSON.stringify(payload),
  };
}

export function unreadableCipher(): EmailPayloadCipherPort {
  return {
    encrypt: (): string => 'sealed',
    decrypt: () => {
      throw new Error('email outbox envelope is malformed');
    },
  };
}

export function unknownKeyVersionCipher(): EmailPayloadCipherPort {
  return {
    encrypt: (): string => 'sealed',
    decrypt: () => {
      throw new EmailPayloadUnknownKeyVersionError();
    },
  };
}

export function harness(
  options: {
    payload?: EmailDeliveryPayload;
    sender?: RecordingSender;
    credential?: EmailCredentialState;
    rateReservation?: {
      readonly reserved: boolean;
      readonly retryAfterMs?: number;
    };
    rateLimiter?: FakeEmailSendRateLimiter;
    outageCircuit?: FakeEmailProviderOutageCircuit;
    dailySendBudget?: EmailDailySendBudgetPort;
    now?: () => Date;
    notices?: EmailNoticeResolvers;
    onTerminalFailure?: (failure: {
      readonly id: string;
      readonly kind: EmailDeliveryKind;
      readonly errorCode: string;
    }) => void;
    onProviderConfigurationFailure?: (failure: {
      readonly status: number;
    }) => void;
  } = {},
): {
  poller: EmailDeliveryPoller;
  store: FakeStore;
  credentials: FakeCredentials;
  sender: RecordingSender;
  outageCircuit: FakeEmailProviderOutageCircuit;
} {
  const store = new FakeStore();
  const credentials = new FakeCredentials();
  credentials.state = options.credential ?? 'actionable';
  const sender = options.sender ?? new RecordingSender();
  const rateLimiter = options.rateLimiter ?? new FakeEmailSendRateLimiter();
  const outageCircuit =
    options.outageCircuit ?? new FakeEmailProviderOutageCircuit();
  if (options.rateReservation !== undefined) {
    rateLimiter.result = options.rateReservation.reserved
      ? { reserved: true }
      : {
          reserved: false,
          retryAfterMs: options.rateReservation.retryAfterMs ?? 5_000,
        };
  }
  const poller = new EmailDeliveryPoller(
    store,
    credentials,
    sealed(options.payload ?? VERIFICATION_PAYLOAD),
    sender,
    rateLimiter,
    outageCircuit,
    options.now ?? ((): Date => NOW),
    { hash: () => TOKEN_HASH },
    {
      owner: 'instance-a',
      ...(options.notices === undefined ? {} : { notices: options.notices }),
      ...(options.onTerminalFailure === undefined
        ? {}
        : { onTerminalFailure: options.onTerminalFailure }),
      ...(options.onProviderConfigurationFailure === undefined
        ? {}
        : {
            onProviderConfigurationFailure:
              options.onProviderConfigurationFailure,
          }),
      ...(options.dailySendBudget === undefined
        ? {}
        : { dailySendBudget: options.dailySendBudget }),
    },
  );
  return { poller, store, credentials, sender, outageCircuit };
}

export function worstCaseBatchMs(batchSize: number): number {
  return (
    batchSize *
    (EmailDeliveryPoller.ATTEMPT_TIMEOUT_MS +
      EmailDeliveryPoller.REQUEST_OVERHEAD_MS)
  );
}

// (constants above are not referenced by the split specs)
