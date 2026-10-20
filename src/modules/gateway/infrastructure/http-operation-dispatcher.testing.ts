import { Logger } from '@nestjs/common';

import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { DownstreamRetryBudgetPort } from '@/modules/gateway/application/downstream-retry-budget.port';
import { GuardedOperationDispatcher } from '@/modules/gateway/application/guarded-operation-dispatcher';
import type { InternalTokenIssuerPort } from '@/modules/gateway/application/internal-token-issuer.port';
import type { OperationDispatcherPort } from '@/modules/gateway/application/operation-dispatcher.port';
import { SandboxAdmission } from '@/modules/gateway/application/sandbox-admission';
import type { SandboxDispatchBudgetPort } from '@/modules/gateway/application/sandbox-dispatch-budget.port';
import type { DispatchAttemptRecordPort } from '@/modules/metering/public/dispatch-attempts';
import { DownstreamCircuitBreakers } from './downstream-circuit-breakers';
import type { DownstreamHttpClient } from './downstream-http.client';
import {
  DISPATCHER_LOG_CONTEXT,
  HttpOperationTransport,
} from './http-operation-dispatcher';
import { metricsDispatchObserver } from './metrics-dispatch-observer';

/**
 * The dispatcher `GatewayModule` provides, wired by hand for a test: the same
 * transport, policy, and metrics, with the HTTP client and stores faked.
 */
export function createHttpOperationDispatcher(
  httpClient: DownstreamHttpClient,
  tokenIssuer: InternalTokenIssuerPort,
  adapters: readonly DownstreamAdapter<unknown, unknown>[],
  dispatchAttempts: DispatchAttemptRecordPort,
  sandboxBudget?: SandboxDispatchBudgetPort,
  retryBudget?: DownstreamRetryBudgetPort,
  random: () => number = Math.random,
  circuitBreakers = new DownstreamCircuitBreakers(),
): OperationDispatcherPort {
  const logger = new Logger(DISPATCHER_LOG_CONTEXT);
  const warn = (message: string): void => logger.warn(message);
  return new GuardedOperationDispatcher(
    new HttpOperationTransport(
      httpClient,
      tokenIssuer,
      adapters,
      circuitBreakers,
      retryBudget,
      random,
    ),
    dispatchAttempts,
    new SandboxAdmission(sandboxBudget, warn),
    metricsDispatchObserver,
    warn,
  );
}
