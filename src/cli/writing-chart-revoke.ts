import process from 'node:process';

import type {
  WritingChartPublicEdgeOutcome,
  WritingChartRevocationAuditRepositoryPort,
  WritingChartRevocationStoragePort,
} from '@/modules/writing/application/writing-chart-revocation.port';
import { S3WritingChartUploadStorage } from '@/modules/writing/infrastructure/s3-writing-chart-upload.storage';
import {
  type WritingChartEnvironment,
  isWritingChartAssetId,
} from '@/modules/writing/public/chart-revocation';
import { createCliSeaweedFsClient } from './seaweedfs-client';

export type WritingChartRevokeErrorCode =
  | 'INVALID_PUBLIC_URL'
  | 'ACTOR_INVALID'
  | 'DATABASE_FAILURE'
  | 'AUDIT_COMPLETION_FAILURE';

export class WritingChartRevokeError extends Error {
  constructor(readonly code: WritingChartRevokeErrorCode) {
    super(code);
    this.name = WritingChartRevokeError.name;
  }
}

export interface WritingChartRevokeCliInput {
  readonly databaseUrl: string;
  readonly environment: WritingChartEnvironment;
  readonly url: string;
  readonly actorUsername: string;
  readonly audit?: WritingChartRevocationAuditRepositoryPort;
  readonly storage?: WritingChartRevocationStoragePort;
  readonly probe?: (url: string) => Promise<{
    readonly state: WritingChartPublicEdgeOutcome;
    readonly status: number | null;
  }>;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

interface ParsedPublicChartUrl {
  readonly url: URL;
  readonly assetId: string;
  readonly publishedKey: string;
}

const BUCKET_BY_ENVIRONMENT: Readonly<Record<WritingChartEnvironment, string>> =
  {
    production: 'aihub-writing-charts',
    sandbox: 'aihub-sandbox-writing-charts',
  };

function parsePublicChartUrl(
  raw: string,
  environment: WritingChartEnvironment,
): ParsedPublicChartUrl | undefined {
  if (raw !== raw.trim() || raw.includes('?') || raw.includes('#')) {
    return undefined;
  }
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1];
  if (authority === undefined || authority.includes('@')) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hostname !== 's3.wispace.app' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return undefined;
  }

  const match =
    /^\/(aihub-writing-charts|aihub-sandbox-writing-charts)\/(writing-charts\/(chart_[0-9A-HJKMNP-TV-Z]{26})\/published)$/.exec(
      url.pathname,
    );
  const bucket = match?.[1];
  const publishedKey = match?.[2];
  const assetId = match?.[3];
  if (
    bucket !== BUCKET_BY_ENVIRONMENT[environment] ||
    publishedKey === undefined ||
    assetId === undefined ||
    !isWritingChartAssetId(assetId)
  ) {
    return undefined;
  }
  return { url, assetId, publishedKey };
}

async function probePublicChartEdge(url: string): Promise<{
  readonly state: WritingChartPublicEdgeOutcome;
  readonly status: number | null;
}> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return {
      state:
        response.status >= 200 && response.status < 300
          ? 'serving'
          : response.status >= 300 && response.status < 400
            ? 'redirect'
            : [401, 403, 404, 410].includes(response.status)
              ? 'not_serving'
              : 'unavailable',
      status: response.status,
    };
  } catch {
    return { state: 'unavailable', status: null };
  }
}

function createStorage(environment: WritingChartEnvironment) {
  return new S3WritingChartUploadStorage(createCliSeaweedFsClient(), {
    environment,
    ...(process.env.SEAWEEDFS_CHART_STAGING_BUCKET === undefined
      ? {}
      : { stagingBucket: process.env.SEAWEEDFS_CHART_STAGING_BUCKET }),
    ...(process.env.SEAWEEDFS_CHART_PUBLIC_BUCKET === undefined
      ? {}
      : { publicBucket: process.env.SEAWEEDFS_CHART_PUBLIC_BUCKET }),
    ...(process.env.AIHUB_CHART_PUBLIC_BASE_URL === undefined
      ? {}
      : { publicBaseUrl: process.env.AIHUB_CHART_PUBLIC_BASE_URL }),
  });
}

export async function runWritingChartRevokeCommand(
  input: WritingChartRevokeCliInput,
) {
  const parsed = parsePublicChartUrl(input.url, input.environment);
  if (parsed === undefined) {
    throw new WritingChartRevokeError('INVALID_PUBLIC_URL');
  }

  const audit =
    input.audit ??
    (await (
      await import('./operator-writing-chart-client')
    ).createOperatorWritingChartRevocationAuditClient(input.databaseUrl));
  let result:
    | {
        readonly assetId: string;
        readonly origin: 'deleted' | 'already_absent' | 'failed';
        readonly edge: {
          readonly state: WritingChartPublicEdgeOutcome;
          readonly status: number | null;
        };
        readonly propagationPending: boolean;
      }
    | undefined;

  let operationError: unknown;
  try {
    let actorUserAccountId: string | undefined;
    try {
      actorUserAccountId = await audit.findActiveOperatorAccount(
        input.actorUsername,
      );
    } catch {
      throw new WritingChartRevokeError('DATABASE_FAILURE');
    }
    if (actorUserAccountId === undefined) {
      throw new WritingChartRevokeError('ACTOR_INVALID');
    }

    let occurredAt: Date;
    try {
      occurredAt = (input.now ?? (() => new Date()))();
      if (Number.isNaN(occurredAt.getTime())) throw new Error('invalid clock');
    } catch {
      throw new WritingChartRevokeError('DATABASE_FAILURE');
    }

    try {
      await audit.append({
        assetId: parsed.assetId,
        actorUserAccountId,
        occurredAt,
        phase: 'requested',
        originOutcome: null,
        edgeOutcome: null,
        edgeStatus: null,
      });
    } catch {
      throw new WritingChartRevokeError('DATABASE_FAILURE');
    }

    let origin: 'deleted' | 'already_absent' | 'failed' = 'failed';
    try {
      const storage = input.storage ?? createStorage(input.environment);
      origin = await storage.deletePublishedObjectIfPresent({
        environment: input.environment,
        publishedKey: parsed.publishedKey,
      });
    } catch {
      origin = 'failed';
    }

    let edge: {
      readonly state: WritingChartPublicEdgeOutcome;
      readonly status: number | null;
    };
    try {
      edge = await (input.probe ?? probePublicChartEdge)(parsed.url.href);
    } catch {
      edge = { state: 'unavailable', status: null };
    }

    let completedAt: Date;
    try {
      completedAt = (input.now ?? (() => new Date()))();
      if (Number.isNaN(completedAt.getTime())) throw new Error('invalid clock');
    } catch {
      throw new WritingChartRevokeError('DATABASE_FAILURE');
    }
    try {
      await audit.append({
        assetId: parsed.assetId,
        actorUserAccountId,
        occurredAt: completedAt,
        phase: 'completed',
        originOutcome: origin,
        edgeOutcome: edge.state,
        edgeStatus: edge.status,
      });
    } catch {
      throw new WritingChartRevokeError('AUDIT_COMPLETION_FAILURE');
    }

    result = {
      assetId: parsed.assetId,
      origin,
      edge,
      propagationPending: origin !== 'failed' && edge.state === 'serving',
    };
  } catch (error) {
    operationError = error;
  }
  try {
    await audit.close?.();
  } catch {
    operationError ??= new WritingChartRevokeError('DATABASE_FAILURE');
  }
  if (operationError !== undefined) {
    throw operationError;
  }

  if (result === undefined) {
    throw new WritingChartRevokeError('DATABASE_FAILURE');
  }
  (input.emit ?? console.log)(JSON.stringify(result));
  return result;
}
