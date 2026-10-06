/**
 * Synthetic canary check for the AI Writing contract.
 *
 * Calls both live AI Writing grading endpoints with fixed known-good inputs,
 * parses each response through the real production adapter code, and reports
 * drift. Catches response-shape drift before a customer's request hits it.
 *
 * Invoked by external cron (not an in-process scheduler). Recommended
 * interval: every 6 hours — see docs/operations/canary-ai-writing.md.
 *
 * Exit codes:
 *   0 — both passed
 *   1 — drift (AI_SERVICE_CONTRACT_VIOLATION on at least one)
 *   2 — unverified (transport / timeout / HTTP error, no contract violation)
 *   3 — webhook delivery failed
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

import { ulid } from 'ulid';

import { createCliRuntimeSecretProvider } from '@/cli/runtime-secret-provider';
import { AppError } from '@/common/errors/app-error';
import type { RequestContext } from '@/common/request-context/request-context';
import { task1GradeAdapter } from '@/downstream/writing/task1-grade.adapter';
import { task2GradeAdapter } from '@/downstream/writing/task2-grade.adapter';
import type { DownstreamHttpRequestOptions } from '@/modules/gateway/infrastructure/downstream-http.client';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/downstream-http.client';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The failure class reported in the webhook and exit-code decision. */
export type FailureClass =
  | 'AI_SERVICE_CONTRACT_VIOLATION'
  | 'transport'
  | 'timeout'
  | 'http_5xx'
  | 'http_429';

export interface OperationFailure {
  readonly operation: string;
  readonly class: FailureClass;
  /** AppError.code plus HTTP status only — never cause.message, never essay text. */
  readonly detail: string;
}

export interface OperationSuccess {
  readonly operation: string;
  readonly downstream_ms: number;
}

/** The structured result returned by runCanary. */
export interface CanaryResult {
  readonly run_id: string;
  readonly checked_at: string;
  readonly outcome: 'ok' | 'drift' | 'unverified';
  readonly successes: readonly OperationSuccess[];
  readonly failures: readonly OperationFailure[];
}

/** Exit code derived from the canary outcome. */
export type ExitCode = 0 | 1 | 2 | 3;

export interface CanaryRunDeps {
  /** A DownstreamHttpClient pointed at DOWNSTREAM_AI_WRITING_URL. */
  readonly httpClient: DownstreamHttpClient;
  /** Authorization header value, e.g. `Bearer <token>`. */
  readonly authorization: string;
  /**
   * Optional in-process webhook sink. When provided, failures are POSTed here.
   * Unset => the caller logs the payload; the canary outcome is unchanged.
   *
   * Accepting a function rather than a URL lets tests inject an in-memory sink
   * without standing up an HTTP server.
   */
  readonly webhookSink?: (payload: WebhookPayload) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Webhook payload shape
// ---------------------------------------------------------------------------

export interface WebhookPayload {
  readonly event: 'canary_ai_writing';
  readonly run_id: string;
  readonly outcome: 'drift' | 'unverified';
  readonly checked_at: string;
  readonly failures: ReadonlyArray<{
    readonly operation: string;
    readonly class: FailureClass;
    readonly detail: string;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-call timeout for downstream AI Writing requests. */
const CANARY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Minimal RequestContext stub
//
// Both adapters call `void context` — they accept and immediately discard
// the context. A minimal stub that satisfies the type is all we need.
// ---------------------------------------------------------------------------

function makeStubContext(signal: AbortSignal): RequestContext {
  const now = new Date();
  return {
    requestId: ulid(),
    receivedAt: now,
    deadlineAt: new Date(now.getTime() + CANARY_TIMEOUT_MS),
    scopes: [],
    signal,
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

function classifyError(error: unknown): FailureClass {
  if (error instanceof AppError) {
    if (error.code === 'AI_SERVICE_CONTRACT_VIOLATION') {
      return 'AI_SERVICE_CONTRACT_VIOLATION';
    }
    if (error.code === 'AI_SERVICE_TIMEOUT') {
      return 'timeout';
    }
    if (
      error.code === 'AI_SERVICE_UNAVAILABLE' ||
      error.code === 'AI_SERVICE_ERROR' ||
      error.code === 'AI_SERVICE_THROTTLED'
    ) {
      if (error.downstreamStatus === 429) {
        return 'http_429';
      }
      if (
        error.downstreamStatus !== undefined &&
        error.downstreamStatus >= 500
      ) {
        return 'http_5xx';
      }
      return 'transport';
    }
    return 'transport';
  }
  return 'transport';
}

/**
 * Build a safe detail string: AppError.code plus HTTP status only.
 * Never read cause.message — on the contract-violation path it can carry a
 * fragment of the raw downstream body (same leak class as issue #17).
 */
function safeDetail(error: unknown): string {
  if (error instanceof AppError) {
    const status =
      error.downstreamStatus !== undefined
        ? ` (HTTP ${error.downstreamStatus})`
        : '';
    return `${error.code}${status}`;
  }
  return 'UNKNOWN_ERROR';
}

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

interface ProbeOptions {
  readonly httpClient: DownstreamHttpClient;
  readonly authorization: string;
}

async function probeOperation<TInput, TOutput>(
  adapter: {
    readonly operation: string;
    buildRequest(
      input: TInput,
      context: RequestContext,
    ): {
      method: 'GET' | 'POST';
      path: string;
      body?: unknown;
      contentType?: string;
    };
    parseResponse(raw: {
      status: number;
      headers: Readonly<Record<string, string>>;
      body: unknown;
    }): TOutput;
  },
  input: TInput,
  options: ProbeOptions,
): Promise<OperationSuccess | OperationFailure> {
  const signal = AbortSignal.timeout(CANARY_TIMEOUT_MS);
  const context = makeStubContext(signal);

  const httpOptions: DownstreamHttpRequestOptions = {
    authorization: options.authorization,
    requestId: context.requestId,
    deadlineMs: CANARY_TIMEOUT_MS,
    signal,
  };

  const start = Date.now();

  try {
    const downstreamRequest = adapter.buildRequest(input, context);
    const response = await options.httpClient.request(
      downstreamRequest,
      httpOptions,
    );

    // The HTTP client throws AppError for non-2xx in most paths, but handle
    // any raw error status that slips through.
    if (response.status >= 400) {
      const cls: FailureClass =
        response.status === 429
          ? 'http_429'
          : response.status >= 500
            ? 'http_5xx'
            : 'transport';
      return {
        operation: adapter.operation,
        class: cls,
        detail: `AI_SERVICE_ERROR (HTTP ${response.status})`,
      };
    }

    adapter.parseResponse(response);

    return {
      operation: adapter.operation,
      downstream_ms: Date.now() - start,
    };
  } catch (error) {
    return {
      operation: adapter.operation,
      class: classifyError(error),
      detail: safeDetail(error),
    };
  }
}

function loadFixture<T>(relativePath: string): T {
  const absolute = join(__dirname, '..', relativePath);
  return JSON.parse(readFileSync(absolute, 'utf8')) as T;
}

// ---------------------------------------------------------------------------
// runCanary — fully testable, no process.exit, no loadEnvFile
// ---------------------------------------------------------------------------

/**
 * Run both grading canary probes sequentially and return a structured result.
 *
 * Fully injectable: pass a MockAgent-backed httpClient to test without network.
 * Does NOT call process.exit or loadEnvFile — those belong to the entrypoint.
 *
 * When `webhookSink` is provided and the outcome is non-ok, the sink is called
 * with the failure payload. If the sink throws, it propagates to the caller so
 * the entrypoint can map it to exit code 3, keeping the distinction between a
 * canary failure (exit 1/2) and a delivery failure (exit 3) intact.
 */
export async function runCanary(deps: CanaryRunDeps): Promise<CanaryResult> {
  const { httpClient, authorization, webhookSink } = deps;
  const runId = ulid();
  const checkedAt = new Date().toISOString();

  // Grade fixtures already exist. They store the downstream field names
  // (topic, url) — map to public contract names before passing to adapters.
  const task1GradeRaw = loadFixture<{
    question: string;
    url: string;
    topic: string;
    essay: string;
  }>('test/fixtures/ai-writing/grade-task1.request.json');
  const task2GradeRaw = loadFixture<{
    question: string;
    topic: string;
    essay: string;
  }>('test/fixtures/ai-writing/grade-task2.request.json');

  const gradeTask1Input = {
    question: task1GradeRaw.question,
    chart_type: task1GradeRaw.topic as 'Bar Chart',
    essay: task1GradeRaw.essay,
    image_url: task1GradeRaw.url,
  };
  const gradeTask2Input = {
    question: task2GradeRaw.question,
    topic: task2GradeRaw.topic,
    essay: task2GradeRaw.essay,
  };

  const probeOpts: ProbeOptions = { httpClient, authorization };

  // Run both sequentially — collect every result even if one fails.
  const rawResults = [
    await probeOperation(task1GradeAdapter, gradeTask1Input, probeOpts),
    await probeOperation(task2GradeAdapter, gradeTask2Input, probeOpts),
  ];

  const successes: OperationSuccess[] = [];
  const failures: OperationFailure[] = [];

  for (const r of rawResults) {
    if ('downstream_ms' in r) {
      successes.push(r);
    } else {
      failures.push(r);
    }
  }

  let outcome: 'ok' | 'drift' | 'unverified';
  if (failures.length === 0) {
    outcome = 'ok';
  } else if (
    failures.some((f) => f.class === 'AI_SERVICE_CONTRACT_VIOLATION')
  ) {
    outcome = 'drift';
  } else {
    outcome = 'unverified';
  }

  const result: CanaryResult = {
    run_id: runId,
    checked_at: checkedAt,
    outcome,
    successes,
    failures,
  };

  // Post to webhook on non-ok outcomes. Never post on success.
  // Throws on delivery failure so the entrypoint can set exit code 3.
  if (outcome !== 'ok' && webhookSink !== undefined) {
    await webhookSink({
      event: 'canary_ai_writing',
      run_id: runId,
      outcome,
      checked_at: checkedAt,
      failures: failures.map((f) => ({
        operation: f.operation,
        class: f.class,
        detail: f.detail,
      })),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Exit code table
// ---------------------------------------------------------------------------

export function exitCodeForResult(
  result: CanaryResult,
  webhookFailed: boolean,
): ExitCode {
  if (webhookFailed) return 3;
  if (result.outcome === 'ok') return 0;
  if (result.outcome === 'drift') return 1;
  return 2;
}

// ---------------------------------------------------------------------------
// HTTP webhook sink — used by the entrypoint, not injected in tests
// ---------------------------------------------------------------------------

const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Build an HTTP webhook sink that POSTs to `url`.
 * Throws on delivery failure (non-2xx or network error).
 */
export function makeHttpWebhookSink(
  url: string,
): (payload: WebhookPayload) => Promise<void> {
  return async (payload) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Webhook POST failed: HTTP ${response.status}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Entrypoint — thin wrapper: parse env, call runCanary, log, exit.
// The entrypoint wrapper is intentionally untested; runCanary is tested.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    loadEnvFile('.env');
  } catch {
    // .env is optional in CI/production where env vars are injected directly.
  }

  const writingUrl = process.env.DOWNSTREAM_AI_WRITING_URL;
  const webhookUrl = process.env.CANARY_WEBHOOK_URL;
  const resolvedWebhookUrl =
    webhookUrl && webhookUrl.trim().length > 0 ? webhookUrl.trim() : undefined;

  if (!writingUrl || writingUrl.trim().length === 0) {
    console.error(
      JSON.stringify({
        event: 'canary_ai_writing_startup_failed',
        reason: 'DOWNSTREAM_AI_WRITING_URL is not set',
      }),
    );
    process.exit(2);
  }

  let writingToken: string;
  try {
    writingToken =
      createCliRuntimeSecretProvider().getSnapshot().aiWriting.token;
  } catch {
    console.error(
      JSON.stringify({
        event: 'canary_ai_writing_startup_failed',
        reason: 'runtime secret source is not configured',
      }),
    );
    process.exit(2);
  }

  const httpClient = new DownstreamHttpClient(writingUrl.trim());
  const webhookSink =
    resolvedWebhookUrl !== undefined
      ? makeHttpWebhookSink(resolvedWebhookUrl)
      : undefined;

  let result: CanaryResult;
  let webhookFailed = false;

  try {
    result = await runCanary({
      httpClient,
      authorization: `Bearer ${writingToken}`,
      ...(webhookSink !== undefined ? { webhookSink } : {}),
    });
  } catch (error) {
    // runCanary throws only when webhookSink throws — all probe errors are
    // caught internally. Map to exit code 3.
    webhookFailed = true;
    console.error(
      JSON.stringify({
        event: 'canary_ai_writing_webhook_failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    // We don't have a CanaryResult here; log what we can and exit 3.
    process.exit(3);
  }

  if (result.outcome === 'ok') {
    console.log(
      JSON.stringify({
        event: 'canary_ai_writing',
        outcome: 'ok',
        run_id: result.run_id,
        results: result.successes.map((s) => ({
          operation: s.operation,
          downstream_ms: s.downstream_ms,
        })),
      }),
    );
  } else {
    const logPayload = {
      event: 'canary_ai_writing',
      run_id: result.run_id,
      outcome: result.outcome,
      checked_at: result.checked_at,
      failures: result.failures,
    };

    if (resolvedWebhookUrl === undefined) {
      // No webhook configured — log at info so the payload is visible.
      console.log(JSON.stringify(logPayload));
    } else {
      console.error(JSON.stringify(logPayload));
    }
  }

  process.exit(exitCodeForResult(result, webhookFailed));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: 'canary_ai_writing_fatal',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(2);
  });
}
