import type { EmailCredentialActionabilityPort } from '@/modules/auth/email-delivery/application/email-credential-actionability.port';
import type { EmailDeliveryRequestRecord } from '@/modules/auth/email-delivery/application/email-delivery-request.types';
import type { EmailDispatchAttemptOutcomePort } from '@/modules/auth/email-delivery/application/email-dispatch-store.port';
import type { ValidatedEmailDelivery } from '@/modules/auth/email-delivery/application/email-kind-handler.registry';
import type { EmailPayloadCipherPort } from '@/modules/auth/email-delivery/application/email-payload-cipher.port';
import type {
  EmailProviderOutageCircuitPort,
  EmailProviderSendPermit,
} from '@/modules/auth/email-delivery/application/email-provider-outage-circuit.port';
import type { EmailSendRateLimiterPort } from '@/modules/auth/email-delivery/application/email-send-rate-limiter.port';
import {
  type EmailMessage,
  type EmailProviderResponse,
  EmailProviderTransportError,
  type EmailSenderPort,
} from '@/modules/auth/email-delivery/application/email-sender.port';
import { readEmailPayload } from '@/modules/auth/email-delivery/application/payload/email-delivery-payload.reader';
import {
  cancelReasonOf,
  errorCodeOf,
  isCredentialExpired,
} from '@/modules/auth/email-delivery/application/send-policy/email-delivery-outcome.policy';
import { emailProviderRetryAfterMs } from '@/modules/auth/email-delivery/application/send-policy/email-provider-retry-after.policy';
import { emailDailySendBudgetCategory } from '@/modules/auth/email-delivery/application/send-policy/email-send-daily-budget.policy';
import { EmailDeliveryPollerMaintenance } from './email-delivery-poller-maintenance';
import type {
  EmailDeliveryPollerOptions,
  EmailDispatchOutcome,
} from './email-delivery-poller.types';
import {
  EMAIL_SEND_RATE_LIMIT_RETRY_MS,
  type EmailProviderPause,
} from './email-provider-pause';

/** How long an unopened payload waits before another instance claims it. */
export const DEFER_RETRY_MS = 5 * 60_000;

export { EMAIL_SEND_RATE_LIMIT_RETRY_MS };

type EmailProviderSendResult = {
  readonly response: EmailProviderResponse;
  readonly responseReceivedAt: Date;
  readonly probeToken: string | undefined;
  readonly generation: number | undefined;
};

type AllowedEmailProviderSendPermit = Extract<
  EmailProviderSendPermit,
  { readonly allowed: true }
>;

type EmailDeliveryPollerDispatchDependencies = {
  readonly store: EmailDispatchAttemptOutcomePort;
  readonly credentials: EmailCredentialActionabilityPort;
  readonly cipher: EmailPayloadCipherPort;
  readonly sender: EmailSenderPort;
  readonly sendRateLimiter: EmailSendRateLimiterPort;
  readonly providerOutageCircuit: EmailProviderOutageCircuitPort;
  readonly now: () => Date;
  readonly tokens: { hash(raw: string): string };
  readonly options: EmailDeliveryPollerOptions;
  readonly maintenance: EmailDeliveryPollerMaintenance;
  readonly pause: EmailProviderPause;
};

export class EmailDeliveryPollerDispatchSteps {
  private readonly store: EmailDispatchAttemptOutcomePort;
  private readonly credentials: EmailCredentialActionabilityPort;
  private readonly cipher: EmailPayloadCipherPort;
  private readonly sender: EmailSenderPort;
  private readonly sendRateLimiter: EmailSendRateLimiterPort;
  private readonly providerOutageCircuit: EmailProviderOutageCircuitPort;
  private readonly now: () => Date;
  private readonly tokens: { hash(raw: string): string };
  private readonly options: EmailDeliveryPollerOptions;
  private readonly maintenance: EmailDeliveryPollerMaintenance;
  private readonly pause: EmailProviderPause;
  private providerConfigurationAlerted = false;

  /** No claim and no provider call before this instant. */
  get providerPausedUntil(): number {
    return this.pause.until;
  }

  constructor(dependencies: EmailDeliveryPollerDispatchDependencies) {
    this.store = dependencies.store;
    this.credentials = dependencies.credentials;
    this.cipher = dependencies.cipher;
    this.sender = dependencies.sender;
    this.sendRateLimiter = dependencies.sendRateLimiter;
    this.providerOutageCircuit = dependencies.providerOutageCircuit;
    this.now = dependencies.now;
    this.tokens = dependencies.tokens;
    this.options = dependencies.options;
    this.maintenance = dependencies.maintenance;
    this.pause = dependencies.pause;
  }

  async readPayload(input: {
    readonly request: EmailDeliveryRequestRecord;
    readonly now: Date;
  }): Promise<ValidatedEmailDelivery | EmailDispatchOutcome> {
    const { request, now } = input;
    let delivery:
      | ValidatedEmailDelivery
      | 'key_unavailable'
      | 'unreadable'
      | 'unrecognised'
      | undefined;
    try {
      delivery = readEmailPayload(this.cipher, request);
    } catch {
      return this.maintenance.defer(request, now, DEFER_RETRY_MS);
    }
    if (delivery === 'unrecognised') {
      // Only a newer release can open it, and one will once it runs: hand the
      // row back unchanged instead of failing a payload that is not corrupt.
      this.options.onUnrecognisedPayload?.({ kind: request.kind });
      return this.maintenance.defer(request, now, DEFER_RETRY_MS);
    }
    if (delivery === 'unreadable' || delivery === 'key_unavailable') {
      // Neither outcome improves by waiting: an unreadable payload would be
      // claimed forever, and the pass cannot restore a key the keyring lost.
      // Both are failures to report, not cancellations: after the claim, fail
      // durably so the erased payload cannot sit in the queue unnoticed, and
      // the distinct codes carry each case to an operator.
      await this.store.markFailed({
        id: request.id,
        failedAt: now,
        errorCode:
          delivery === 'key_unavailable'
            ? 'key_unavailable'
            : 'payload_unreadable',
        owner: this.options.owner,
      });
      return 'failed';
    }
    if (delivery === undefined) {
      // Nothing was left to send: the payload was erased before it was claimed.
      return this.maintenance.cancel(request, 'not_actionable', now);
    }
    return delivery;
  }

  async checkCredentialActionability(input: {
    readonly request: EmailDeliveryRequestRecord;
    readonly credential: ReturnType<ValidatedEmailDelivery['credential']>;
    readonly now: Date;
  }): Promise<EmailDispatchOutcome | undefined> {
    const { request, credential, now } = input;
    if (credential === undefined) return undefined;
    if (isCredentialExpired(credential.expiresAt, now)) {
      return this.maintenance.cancel(request, 'credential_expired', now);
    }

    const state = await this.credentials.check({
      kind: request.kind,
      tokenHash: this.tokens.hash(credential.token),
      now,
    });
    if (state !== 'actionable') {
      return this.maintenance.cancel(request, cancelReasonOf(state), now);
    }
    return undefined;
  }

  async renderMessage(input: {
    readonly delivery: ValidatedEmailDelivery;
    readonly now: Date;
  }): Promise<EmailMessage | undefined> {
    return input.delivery.render({
      ...(this.options.customerWebBaseUrl === undefined
        ? {}
        : { customerWebBaseUrl: this.options.customerWebBaseUrl }),
      now: input.now,
      notices: this.options.notices ?? {},
    });
  }

  async reserveProviderSend(input: {
    readonly request: EmailDeliveryRequestRecord;
    readonly delivery: ValidatedEmailDelivery;
    readonly credential: ReturnType<ValidatedEmailDelivery['credential']>;
    readonly message: EmailMessage;
    readonly now: Date;
  }): Promise<EmailDispatchOutcome | EmailProviderSendResult> {
    const permit = await this.acquireProviderSendPermit({
      request: input.request,
      message: input.message,
      now: input.now,
    });
    if (typeof permit === 'string') return permit;

    const capacityOutcome = await this.reserveSendCapacity({
      request: input.request,
      delivery: input.delivery,
      permit,
    });
    if (capacityOutcome !== undefined) return capacityOutcome;

    return this.sendProviderAttempt({
      request: input.request,
      credential: input.credential,
      message: input.message,
      permit,
    });
  }

  private async acquireProviderSendPermit(input: {
    readonly request: EmailDeliveryRequestRecord;
    readonly message: EmailMessage;
    readonly now: Date;
  }): Promise<AllowedEmailProviderSendPermit | EmailDispatchOutcome> {
    if (
      await this.maintenance.deferInvitationAtRecipientLimit(
        input.request,
        input.message.recipient,
        this.now(),
        EMAIL_SEND_RATE_LIMIT_RETRY_MS,
      )
    )
      return 'deferred';

    let permit: EmailProviderSendPermit;
    try {
      permit = await this.providerOutageCircuit.acquireSendPermit();
    } catch {
      return this.deferForProviderOutage(
        input.request,
        this.now(),
        EMAIL_SEND_RATE_LIMIT_RETRY_MS,
      );
    }
    if (!permit.allowed) {
      return this.deferForProviderOutage(
        input.request,
        this.now(),
        permit.retryAfterMs,
      );
    }
    return permit;
  }

  private async reserveSendCapacity(input: {
    readonly request: EmailDeliveryRequestRecord;
    readonly delivery: ValidatedEmailDelivery;
    readonly permit: AllowedEmailProviderSendPermit;
  }): Promise<EmailDispatchOutcome | undefined> {
    let reservation;
    try {
      reservation = await this.sendRateLimiter.reserve();
    } catch {
      await this.pause.releaseProbe(input.permit.probeToken);
      return this.maintenance.defer(
        input.request,
        this.now(),
        EMAIL_SEND_RATE_LIMIT_RETRY_MS,
      );
    }
    if (!reservation.reserved) {
      await this.pause.releaseProbe(input.permit.probeToken);
      const retryAfterMs = reservation.retryAfterMs;
      return this.maintenance.defer(
        input.request,
        this.now(),
        Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0
          ? retryAfterMs
          : EMAIL_SEND_RATE_LIMIT_RETRY_MS,
      );
    }

    if (this.options.dailySendBudget !== undefined) {
      let budgetReservation;
      try {
        budgetReservation = await this.options.dailySendBudget.reserve(
          emailDailySendBudgetCategory(input.request.kind),
        );
      } catch {
        await this.pause.releaseProbe(input.permit.probeToken);
        return this.maintenance.defer(
          input.request,
          this.now(),
          EMAIL_SEND_RATE_LIMIT_RETRY_MS,
        );
      }
      if (!budgetReservation.reserved) {
        await this.pause.releaseProbe(input.permit.probeToken);
        const deniedAt = this.now();
        const expiresAt = input.delivery.credential()?.expiresAt;
        const remainingCredentialLifetime =
          expiresAt === undefined
            ? Infinity
            : Date.parse(expiresAt) - deniedAt.getTime();
        return this.maintenance.defer(
          input.request,
          deniedAt,
          Number.isFinite(remainingCredentialLifetime) &&
            remainingCredentialLifetime > 0
            ? Math.min(
                budgetReservation.retryAfterMs,
                remainingCredentialLifetime,
              )
            : budgetReservation.retryAfterMs,
        );
      }
    }
    return undefined;
  }

  private async sendProviderAttempt(input: {
    readonly request: EmailDeliveryRequestRecord;
    readonly credential: ReturnType<ValidatedEmailDelivery['credential']>;
    readonly message: EmailMessage;
    readonly permit: AllowedEmailProviderSendPermit;
  }): Promise<EmailDispatchOutcome | EmailProviderSendResult> {
    const { request, credential, message, permit } = input;
    // The attempt is spent before the provider is called, not recorded after it
    // answers: a transition that fails must not hand the same request another
    // pass at the provider.
    // Every time from here on is read fresh: the preflight above takes as long
    // as its dependencies do, and a backoff measured from the start of the
    // pass would let a row become claimable early (#441).
    try {
      await this.store.reserveAttempt({
        id: request.id,
        attemptedAt: this.now(),
        owner: this.options.owner,
      });
    } catch (error) {
      await this.pause.releaseProbe(permit.probeToken);
      throw error;
    }

    // The waits above can outlast the credential; this is the last check
    // before the provider call, not a promise about a concurrent revocation.
    const handoffAt = this.now();
    if (
      credential !== undefined &&
      isCredentialExpired(credential.expiresAt, handoffAt)
    ) {
      await this.pause.releaseProbe(permit.probeToken);
      return this.maintenance.cancel(request, 'credential_expired', handoffAt);
    }

    let response: EmailProviderResponse;
    try {
      response = await this.deliver(request, message);
    } catch (error) {
      if (error instanceof EmailProviderTransportError) {
        const failedAt = this.now();
        const retryAt = await this.pause.open(0, failedAt, permit.probeToken);
        await this.maintenance.releaseUnspentAttempt(request, retryAt);
        return 'provider_outage';
      }
      await this.pause.releaseProbe(permit.probeToken);
      return this.maintenance.recordFailure(
        request,
        errorCodeOf(error),
        this.now(),
      );
    }

    return {
      response,
      responseReceivedAt: this.now(),
      probeToken: permit.probeToken,
      generation: permit.generation,
    };
  }

  async translateProviderOutcome(input: {
    readonly request: EmailDeliveryRequestRecord;
    readonly response: EmailProviderResponse;
    readonly responseReceivedAt: Date;
    readonly probeToken: string | undefined;
    readonly generation: number | undefined;
  }): Promise<EmailDispatchOutcome> {
    const { request, response, responseReceivedAt, probeToken, generation } =
      input;
    if (
      response.status === 429 ||
      (response.status >= 500 && response.status < 600)
    ) {
      return this.translateProviderOutageResponse({
        request,
        response,
        responseReceivedAt,
        probeToken,
      });
    }

    await this.pause.close({
      ...(probeToken === undefined ? {} : { probeToken }),
      ...(generation === undefined ? {} : { generation }),
    });

    if (response.status === 401 || response.status === 403) {
      this.pause.until = responseReceivedAt.getTime() + DEFER_RETRY_MS;
      this.reportProviderConfigurationFailure(response.status);
      await this.maintenance.releaseUnspentAttempt(
        request,
        new Date(this.pause.until),
      );
      return 'configuration_failure';
    }

    if (response.status === 409 && response.idempotencyConflict !== undefined) {
      return this.maintenance.recordIdempotencyConflict(
        request,
        response.idempotencyConflict,
        responseReceivedAt,
      );
    }

    if (response.status === 400 || response.status === 422) {
      await this.store.markFailed({
        id: request.id,
        failedAt: responseReceivedAt,
        errorCode: 'provider_permanent_rejection',
        owner: this.options.owner,
      });
      return 'failed';
    }

    if (response.status < 200 || response.status >= 300) {
      return this.maintenance.recordFailure(
        request,
        'provider_rejected',
        responseReceivedAt,
      );
    }

    await this.store.markProviderAccepted({
      id: request.id,
      attemptedAt: responseReceivedAt,
      owner: this.options.owner,
    });
    this.providerConfigurationAlerted = false;
    return 'provider_accepted';
  }

  private async translateProviderOutageResponse(input: {
    readonly request: EmailDeliveryRequestRecord;
    readonly response: EmailProviderResponse;
    readonly responseReceivedAt: Date;
    readonly probeToken: string | undefined;
  }): Promise<'provider_outage'> {
    const retryAfterMs =
      input.response.status === 429
        ? emailProviderRetryAfterMs(
            input.response.retryAfter,
            input.responseReceivedAt,
          )
        : 0;
    const retryAt = await this.pause.open(
      retryAfterMs,
      input.responseReceivedAt,
      input.probeToken,
    );
    await this.maintenance.releaseUnspentAttempt(input.request, retryAt);
    return 'provider_outage';
  }

  private async deferForProviderOutage(
    request: EmailDeliveryRequestRecord,
    now: Date,
    retryAfterMs: number,
  ): Promise<'provider_outage'> {
    const safeRetryAfterMs =
      Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : EMAIL_SEND_RATE_LIMIT_RETRY_MS;
    this.pause.extend(now.getTime() + safeRetryAfterMs);
    await this.maintenance.defer(
      request,
      now,
      Math.max(EMAIL_SEND_RATE_LIMIT_RETRY_MS, safeRetryAfterMs),
    );
    return 'provider_outage';
  }

  private async deliver(
    request: EmailDeliveryRequestRecord,
    message: EmailMessage,
  ): Promise<EmailProviderResponse> {
    // The row's own id is the provider idempotency key: it is already unique,
    // already durable, and already what every attempt of this request has
    // used, so an uncertain handoff can be retried without a second email.
    return this.sender.send(message, { idempotencyKey: request.id });
  }

  private reportProviderConfigurationFailure(status: 401 | 403): void {
    if (this.providerConfigurationAlerted) return;
    try {
      this.options.onProviderConfigurationFailure?.({ status });
      if (this.options.onProviderConfigurationFailure !== undefined) {
        this.providerConfigurationAlerted = true;
      }
    } catch {
      // A failed alert callback does not turn a held request into a delivery attempt.
    }
  }
}
