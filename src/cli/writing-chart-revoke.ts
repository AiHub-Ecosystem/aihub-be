import {
  WRITING_CHART_PUBLICATION_LEASE_MS,
  type WritingChartEnvironment,
  type WritingChartPublicEdgeOutcome,
  type WritingChartRevocationAuditRepositoryPort,
  type WritingChartRevocationStoragePort,
  isWritingChartAssetId,
} from '@/modules/writing/public/chart-uploads';
import { createCliWritingChartStorage } from './writing-chart-storage';

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

export interface WritingChartRevokeTarget {
  readonly publicUrl: string;
  readonly assetId: string;
  readonly publishedKey: string;
}

export interface WritingChartRevokeEdge {
  readonly state: WritingChartPublicEdgeOutcome;
  readonly status: number | null;
}

export interface WritingChartRevokeResult {
  readonly assetId: string;
  readonly origin: 'deleted' | 'already_absent' | 'failed';
  readonly edge: WritingChartRevokeEdge;
  readonly propagationPending: boolean;
  readonly publicationPending: boolean;
}

const BUCKET_BY_ENVIRONMENT: Readonly<Record<WritingChartEnvironment, string>> =
  {
    production: 'aihub-writing-charts',
    sandbox: 'aihub-sandbox-writing-charts',
  };

export function parseWritingChartRevokeTarget(
  raw: string,
  environment: WritingChartEnvironment,
): WritingChartRevokeTarget | undefined {
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
  return { publicUrl: url.href, assetId, publishedKey };
}

export function formatWritingChartRevokeResult(
  result: WritingChartRevokeResult,
): string {
  return JSON.stringify(result);
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

async function activeOperatorAccount(
  audit: WritingChartRevocationAuditRepositoryPort,
  actorUsername: string,
): Promise<string> {
  let actorUserAccountId: string | undefined;
  try {
    actorUserAccountId = await audit.findActiveOperatorAccount(actorUsername);
  } catch {
    throw new WritingChartRevokeError('DATABASE_FAILURE');
  }
  if (actorUserAccountId === undefined) {
    throw new WritingChartRevokeError('ACTOR_INVALID');
  }
  return actorUserAccountId;
}

function currentTime(input: WritingChartRevokeCliInput): Date {
  try {
    const now = (input.now ?? (() => new Date()))();
    if (Number.isNaN(now.getTime())) throw new Error('invalid clock');
    return now;
  } catch {
    throw new WritingChartRevokeError('DATABASE_FAILURE');
  }
}

async function requestRevocation(
  audit: WritingChartRevocationAuditRepositoryPort,
  target: WritingChartRevokeTarget,
  actorUserAccountId: string,
  occurredAt: Date,
): Promise<boolean> {
  try {
    const result = await audit.requestRevocation(
      {
        assetId: target.assetId,
        actorUserAccountId,
        actorSource: 'self_declared_operator',
        occurredAt,
        phase: 'requested',
        originOutcome: null,
        edgeOutcome: null,
        edgeStatus: null,
      },
      new Date(occurredAt.getTime() - WRITING_CHART_PUBLICATION_LEASE_MS),
    );
    return result.publicationPending;
  } catch {
    throw new WritingChartRevokeError('DATABASE_FAILURE');
  }
}

async function deletePublishedObject(
  input: WritingChartRevokeCliInput,
  target: WritingChartRevokeTarget,
): Promise<'deleted' | 'already_absent' | 'failed'> {
  try {
    const storage =
      input.storage ?? createCliWritingChartStorage(input.environment);
    return await storage.deletePublishedObjectIfPresent({
      environment: input.environment,
      publishedKey: target.publishedKey,
    });
  } catch {
    return 'failed';
  }
}

async function probePublicChart(
  input: WritingChartRevokeCliInput,
  target: WritingChartRevokeTarget,
): Promise<WritingChartRevokeEdge> {
  try {
    return await (input.probe ?? probePublicChartEdge)(target.publicUrl);
  } catch {
    return { state: 'unavailable', status: null };
  }
}

async function appendCompletionAudit(
  audit: WritingChartRevocationAuditRepositoryPort,
  target: WritingChartRevokeTarget,
  actorUserAccountId: string,
  completedAt: Date,
  origin: WritingChartRevokeResult['origin'],
  edge: WritingChartRevokeEdge,
): Promise<void> {
  try {
    await audit.append({
      assetId: target.assetId,
      actorUserAccountId,
      actorSource: 'self_declared_operator',
      occurredAt: completedAt,
      phase: 'completed',
      originOutcome: origin,
      edgeOutcome: edge.state,
      edgeStatus: edge.status,
    });
  } catch {
    throw new WritingChartRevokeError('AUDIT_COMPLETION_FAILURE');
  }
}

async function revokeWritingChartTarget(
  input: WritingChartRevokeCliInput,
  target: WritingChartRevokeTarget,
  audit: WritingChartRevocationAuditRepositoryPort,
): Promise<WritingChartRevokeResult> {
  const actorUserAccountId = await activeOperatorAccount(
    audit,
    input.actorUsername,
  );
  const occurredAt = currentTime(input);
  // A publication inside its lease may still write the object (#1206).
  const publicationPending = await requestRevocation(
    audit,
    target,
    actorUserAccountId,
    occurredAt,
  );
  const origin = await deletePublishedObject(input, target);
  const edge = await probePublicChart(input, target);
  const completedAt = currentTime(input);
  await appendCompletionAudit(
    audit,
    target,
    actorUserAccountId,
    completedAt,
    origin,
    edge,
  );
  return {
    assetId: target.assetId,
    origin,
    edge,
    propagationPending: origin !== 'failed' && edge.state === 'serving',
    publicationPending,
  };
}

async function runAndCloseAudit(
  input: WritingChartRevokeCliInput,
  target: WritingChartRevokeTarget,
  audit: WritingChartRevocationAuditRepositoryPort,
): Promise<WritingChartRevokeResult> {
  let result: WritingChartRevokeResult | undefined;
  let operationError: unknown;
  try {
    result = await revokeWritingChartTarget(input, target, audit);
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
  return result;
}

export async function runWritingChartRevokeCommand(
  input: WritingChartRevokeCliInput,
): Promise<WritingChartRevokeResult> {
  const target = parseWritingChartRevokeTarget(input.url, input.environment);
  if (target === undefined) {
    throw new WritingChartRevokeError('INVALID_PUBLIC_URL');
  }

  const audit =
    input.audit ??
    (await (
      await import('./operator-writing-chart-client')
    ).createOperatorWritingChartRevocationAuditClient(input.databaseUrl));
  const result = await runAndCloseAudit(input, target, audit);
  (input.emit ?? console.log)(formatWritingChartRevokeResult(result));
  return result;
}
