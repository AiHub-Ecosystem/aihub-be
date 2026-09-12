export type DownstreamId = 'ai-writing' | 'ai-speaking';

export interface DownstreamMultipartBody {
  readonly kind: 'multipart';
  readonly fields: Readonly<Record<string, string>>;
  readonly file: {
    readonly fieldName: string;
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly contentType: string;
  };
}

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
