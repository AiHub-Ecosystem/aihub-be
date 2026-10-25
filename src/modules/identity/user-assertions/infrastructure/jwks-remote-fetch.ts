import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';

import { AppError } from '@/common/errors/app-error';
import { parsePublicJsonWebKeySet } from '@/modules/identity/domain/organization-identity-config';
import type { PublicJsonWebKeySet } from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';

import {
  type DnsResolverFactory,
  assertSafeHost,
  pinnedLookup,
} from './jwks-host-safety';
import {
  invalidJwks,
  sourceUnavailable,
  unsafeUrl,
} from './jwks-source-errors';

const JWKS_FETCH_TIMEOUT_MS = 3_000;
export const JWKS_MAX_RESPONSE_BYTES = 64 * 1024;
const JWKS_DISPATCHER = Symbol('JWKS_DISPATCHER');

interface FetchInit {
  readonly [JWKS_DISPATCHER]?: Dispatcher;
  readonly redirect?: 'error' | 'manual';
  readonly credentials?: 'omit';
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

export type JwksFetcher = (
  url: string,
  init?: FetchInit,
) => Promise<FetchResponse>;

export const defaultJwksFetcher: JwksFetcher = (url, init) => {
  const dispatcher = init?.[JWKS_DISPATCHER];

  return undiciFetch(url, {
    ...(dispatcher === undefined ? {} : { dispatcher }),
    ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
    ...(init?.credentials === undefined
      ? {}
      : { credentials: init.credentials }),
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    ...(init?.signal === undefined ? {} : { signal: init.signal }),
  });
};

async function readLimitedBody(response: FetchResponse): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > JWKS_MAX_RESPONSE_BYTES
    ) {
      throw invalidJwks();
    }
  }

  if (response.body === null) {
    throw invalidJwks();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const next = await reader.read().catch((cause: unknown) => {
        throw sourceUnavailable(true, cause);
      });
      if (next.done) {
        break;
      }

      total += next.value.byteLength;
      if (total > JWKS_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw invalidJwks();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchRemoteJwks(
  urlValue: string,
  fetcher: JwksFetcher,
  resolverFactory: DnsResolverFactory,
): Promise<PublicJsonWebKeySet> {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch (error) {
    throw new Error('JWKS URL is invalid', { cause: error });
  }

  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw unsafeUrl();
  }

  const deadlineAt = Date.now() + JWKS_FETCH_TIMEOUT_MS;
  const addresses = await assertSafeHost(
    url.hostname,
    resolverFactory,
    deadlineAt,
  );
  const remainingMs = Math.max(1, deadlineAt - Date.now());
  const dispatcher = new Agent({
    connect: {
      lookup: pinnedLookup(addresses),
      timeout: remainingMs,
    },
    connections: 1,
  });

  try {
    let response: FetchResponse;
    try {
      response = await fetcher(url.toString(), {
        [JWKS_DISPATCHER]: dispatcher,
        redirect: 'manual',
        credentials: 'omit',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch (cause) {
      throw sourceUnavailable(true, cause);
    }

    if (response.status >= 300 && response.status < 400) {
      throw unsafeUrl();
    }
    if (!response.ok) {
      const retryable =
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      throw sourceUnavailable(retryable);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readLimitedBody(response));
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw invalidJwks();
    }
    const jwks = parsePublicJsonWebKeySet(parsed);
    if (jwks === undefined) {
      throw invalidJwks();
    }

    return jwks;
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}
