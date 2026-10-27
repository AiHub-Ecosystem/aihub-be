export interface OpenApiOperationMetadata {
  readonly summary: string;
  readonly description?: string;
  readonly extensions?: Readonly<Record<`x-${string}`, unknown>>;
}

export interface OpenApiParameterMetadata {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly description?: string;
  readonly style?: 'form';
  readonly explode?: boolean;
  readonly schema: unknown;
}

export interface CacheControlPolicy {
  readonly value: 'no-store';
  readonly description?: string;
}

export interface PublicRouteOpenApiMetadata extends OpenApiOperationMetadata {
  readonly includeCorrelationId?: boolean;
  readonly parameters?: readonly OpenApiParameterMetadata[];
  readonly successDescription: string;
  readonly replayHeaderDescription?: string;
  readonly alternateSuccessResponses?: readonly {
    readonly status: 200 | 201 | 202 | 204;
    readonly description: string;
  }[];
}
