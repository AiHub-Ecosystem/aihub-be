import type { OperationId } from '../../../catalog/operation-id';
import type { RequestContext } from '../../../common/request-context/request-context';

export interface InternalTokenIssuerPort {
  mint(context: RequestContext, operation: OperationId): Promise<string>;
}

export const INTERNAL_TOKEN_ISSUER = Symbol('INTERNAL_TOKEN_ISSUER');
