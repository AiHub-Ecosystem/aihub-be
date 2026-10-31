import type { Blob } from 'node:buffer';

import type { ErrorCode } from '@/common/errors/error-code';
import type { UserIdentityMode } from '@/common/request-context/request-context';

export type DownstreamId = 'ai-writing' | 'ai-speaking';

export interface DownstreamMultipartBody {
  readonly kind: 'multipart';
  readonly fields: Readonly<Record<string, string>>;
  readonly file: {
    readonly fieldName: string;
    readonly blob: Blob;
    readonly filename: string;
    readonly contentType: string;
  };
}

export interface DownstreamIdentityHeaders {
  readonly 'x-aihub-organization-id': string;
  readonly 'x-aihub-user-id': string;
  readonly 'x-aihub-user-identity-mode': UserIdentityMode;
}

export interface DownstreamRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly headers?: DownstreamIdentityHeaders;
  readonly body?: unknown;
  readonly contentType?: string;
}

export interface InternalAIServiceResponse<TBody> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: TBody;
}

/**
 * A provider failure an adapter can name. The code is a public error code, so
 * an adapter cannot put an unregistered code into the error envelope, and the
 * message is AIHUB's own: never the provider's text.
 */
export interface DownstreamErrorHint {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}
