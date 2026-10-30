declare module 'k6/execution' {
  const execution: {
    scenario: { iterationInTest: number; startTime: number };
    vu: { idInTest: number };
  };
  export default execution;
}

declare module 'k6/http' {
  type Tags = Record<string, string>;
  type Params = {
    headers?: Record<string, string>;
    tags?: Tags;
    timeout?: string;
  };
  type HttpResponse = {
    status: number;
    error_code: number;
    error: unknown;
    timings: { duration: number };
    headers: Record<string, string | string[] | undefined>;
    body: string;
  };
  type FileData = { data: Uint8Array; filename: string; content_type: string };
  const http: {
    get(url: string, params?: Params): HttpResponse;
    post(
      url: string,
      data?: string | Record<string, unknown> | null,
      params?: Params,
    ): HttpResponse;
    file(data: Uint8Array, filename: string, contentType: string): FileData;
  };
  export default http;
}

declare module 'k6/metrics' {
  type Tags = Record<string, string>;
  export class Counter {
    constructor(name: string);
    add(value: number, tags?: Tags): void;
  }
  export class Gauge {
    constructor(name: string);
    add(value: number, tags?: Tags): void;
  }
  export class Trend {
    constructor(name: string, isTime?: boolean);
    add(value: number, tags?: Tags): void;
  }
}

declare const __ENV: Record<string, string | undefined>;
declare const __VU: number;
declare const __ITER: number;
declare function open(path: string): string;
