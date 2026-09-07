import type { OperationId } from '../catalog/operation-id';
import type { RequestContext } from '../common/request-context/request-context';
import type {
  DownstreamErrorHint,
  DownstreamId,
  DownstreamRequest,
  InternalAIServiceResponse,
} from './downstream.types';

export interface DownstreamAdapter<TInput, TOutput> {
  readonly operation: OperationId;
  readonly downstream: DownstreamId;
  buildRequest(input: TInput, context: RequestContext): DownstreamRequest;
  parseResponse(raw: InternalAIServiceResponse<unknown>): TOutput;
  parseError?(status: number, body: unknown): DownstreamErrorHint | undefined;
}
