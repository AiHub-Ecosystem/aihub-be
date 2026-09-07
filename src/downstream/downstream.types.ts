export type DownstreamId = 'ai-writing';

export interface DownstreamRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly contentType?: string;
}

export interface InternalAIServiceResponse<TBody> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: TBody;
}

export interface DownstreamErrorHint {
  readonly code: string;
  readonly retryable: boolean;
}
