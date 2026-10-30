import { isRecord } from '@/common/is-record';
import { ALLOWED_EXTENSIONS } from '@/modules/speaking/infrastructure/fastify-speaking-multipart.parser';

// The request an operational smoke helper must send, read from the OpenAPI
// document built from source (#1403), and a comparison with what the helper
// really sends. The contract is the only source of the expected values: a
// second list kept in a test would drift with the helper.

type Json = Record<string, unknown>;

export interface ExpectedRequest {
  readonly method: string;
  readonly path: string;
  readonly mediaType: string;
  readonly headers: readonly {
    readonly name: string;
    readonly required: boolean;
  }[];
  readonly fields: readonly {
    readonly name: string;
    readonly required: boolean;
    /** A file part (`format: binary`). */
    readonly binary: boolean;
  }[];
}

export interface EmittedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: readonly string[];
  /** Whether the body goes out as `multipart/form-data`. */
  readonly multipart: boolean;
  readonly fields: readonly {
    readonly name: string;
    /** The file name of a file part, as the helper passes it to curl. */
    readonly filename?: string;
  }[];
}

/**
 * Optional headers and fields the helper sends on purpose. A requiredness
 * change in the contract moves an item between "required" and "optional", so
 * it shows up as drift here whichever way it goes.
 */
export interface DeliberateOptionals {
  readonly headers?: readonly string[];
  readonly fields?: readonly string[];
}

export const MULTIPART = 'multipart/form-data';
const METHODS = ['get', 'put', 'post', 'delete', 'patch'];

function member(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function need(value: unknown, what: string): Json {
  if (!isRecord(value)) {
    throw new Error(`the OpenAPI document has no ${what}`);
  }
  return value;
}

function resolveRef(document: unknown, value: unknown): unknown {
  const ref = member(value, '$ref');
  if (typeof ref !== 'string') {
    return value;
  }
  let target: unknown = document;
  for (const part of ref.replace(/^#\//, '').split('/')) {
    target = member(target, part.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return target;
}

function findOperation(
  document: unknown,
  operationId: string,
): { path: string; method: string; operation: Json } {
  const paths = need(member(document, 'paths'), 'paths');
  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const operation = member(item, method);
      if (member(operation, 'operationId') === operationId) {
        return {
          path,
          method: method.toUpperCase(),
          operation: need(operation, operationId),
        };
      }
    }
  }
  throw new Error(`the OpenAPI document has no operation ${operationId}`);
}

/**
 * Headers the operation takes: the header-carried API key scheme it requires,
 * and its header parameters. A security requirement with one alternative makes
 * its header required; with several alternatives each is accepted, none required.
 */
function expectedHeaders(
  document: unknown,
  operation: Json,
): ExpectedRequest['headers'] {
  const headers: { name: string; required: boolean }[] = [];
  // An operation without its own `security` inherits the document's.
  const inherited = member(document, 'security');
  const security = Array.isArray(operation.security)
    ? operation.security
    : Array.isArray(inherited)
      ? inherited
      : [];
  const schemes = member(member(document, 'components'), 'securitySchemes');
  for (const requirement of security) {
    for (const schemeName of Object.keys(
      isRecord(requirement) ? requirement : {},
    )) {
      const scheme = member(schemes, schemeName);
      if (
        member(scheme, 'type') === 'apiKey' &&
        member(scheme, 'in') === 'header'
      ) {
        const name = member(scheme, 'name');
        if (typeof name === 'string') {
          headers.push({ name, required: security.length === 1 });
        }
      }
    }
  }
  const parameters = Array.isArray(operation.parameters)
    ? operation.parameters
    : [];
  for (const raw of parameters) {
    const parameter = resolveRef(document, raw);
    const name = member(parameter, 'name');
    if (member(parameter, 'in') === 'header' && typeof name === 'string') {
      headers.push({ name, required: member(parameter, 'required') === true });
    }
  }
  return headers;
}

export function expectedRequestFrom(
  document: unknown,
  operationId: string,
): ExpectedRequest {
  const { path, method, operation } = findOperation(document, operationId);
  const content = need(
    member(member(operation, 'requestBody'), 'content'),
    'request body',
  );
  const mediaType = Object.keys(content)[0];
  if (mediaType === undefined) {
    throw new Error(`${operationId} has no request media type`);
  }
  const schema = need(
    resolveRef(document, member(content[mediaType], 'schema')),
    'request schema',
  );
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = need(schema.properties, 'request properties');
  return {
    method,
    path,
    mediaType,
    headers: expectedHeaders(document, operation),
    fields: Object.entries(properties).map(([name, property]) => ({
      name,
      required: required.includes(name),
      binary: member(property, 'format') === 'binary',
    })),
  };
}

/**
 * The comparison. Header names compare case-insensitively, as HTTP does. The
 * OpenAPI document publishes no content type for a part. The route decides on
 * the audio file's extension (not on the part's `Content-Type`), so that is
 * what a file part is held to.
 */
export function driftBetween(
  contract: ExpectedRequest,
  emitted: EmittedRequest,
  deliberate: DeliberateOptionals = {},
): string[] {
  const drift: string[] = [];
  if (emitted.method !== contract.method) {
    drift.push(`sends ${emitted.method}, the contract has ${contract.method}`);
  }
  if (emitted.path !== contract.path) {
    drift.push(`sends to ${emitted.path}, the contract has ${contract.path}`);
  }
  if (contract.mediaType === MULTIPART && !emitted.multipart) {
    drift.push(`does not send ${MULTIPART}`);
  }
  if (contract.mediaType !== MULTIPART && emitted.multipart) {
    drift.push(`sends ${MULTIPART}, the contract has ${contract.mediaType}`);
  }

  const known = new Set(contract.headers.map((h) => h.name.toLowerCase()));
  const sent = new Set(emitted.headers.map((name) => name.toLowerCase()));
  for (const name of emitted.headers) {
    if (!known.has(name.toLowerCase())) {
      drift.push(`sends header "${name}", which the contract lacks`);
    }
  }
  for (const { name, required } of contract.headers) {
    if (required && !sent.has(name.toLowerCase())) {
      drift.push(`omits required header "${name}"`);
    }
  }
  const deliberateHeaders = new Set(
    (deliberate.headers ?? []).map((name) => name.toLowerCase()),
  );
  for (const { name, required } of contract.headers) {
    const lower = name.toLowerCase();
    if (required && deliberateHeaders.has(lower)) {
      drift.push(
        `lists header "${name}" as optional, but the contract requires it`,
      );
    }
    if (!required && sent.has(lower) && !deliberateHeaders.has(lower)) {
      drift.push(
        `sends header "${name}", which the contract no longer requires`,
      );
    }
  }

  const fieldNames = new Set(contract.fields.map((f) => f.name));
  const sentFields = new Set(emitted.fields.map((f) => f.name));
  for (const { name } of emitted.fields) {
    if (!fieldNames.has(name)) {
      drift.push(`sends form field "${name}", which the contract lacks`);
    }
  }
  for (const { name, required } of contract.fields) {
    if (required && !sentFields.has(name)) {
      drift.push(`omits required form field "${name}"`);
    }
  }
  const deliberateFields = new Set(deliberate.fields ?? []);
  for (const { name, required } of contract.fields) {
    if (required && deliberateFields.has(name)) {
      drift.push(
        `lists form field "${name}" as optional, but the contract requires it`,
      );
    }
    if (!required && sentFields.has(name) && !deliberateFields.has(name)) {
      drift.push(
        `sends form field "${name}", which the contract no longer requires`,
      );
    }
  }

  for (const field of contract.fields.filter((f) => f.binary)) {
    const filename = emitted.fields.find(
      (f) => f.name === field.name,
    )?.filename;
    const dot = filename?.lastIndexOf('.') ?? -1;
    const extension =
      filename === undefined || dot === -1
        ? ''
        : filename.slice(dot + 1).toLowerCase();
    if (filename !== undefined && !ALLOWED_EXTENSIONS.has(extension)) {
      drift.push(
        `sends ${field.name} file "${filename}", whose extension the route rejects (it takes ${[...ALLOWED_EXTENSIONS].join(', ')})`,
      );
    }
  }
  return drift;
}

/** Reads the curl config file a helper writes (`--config`) into a request. */
export function emittedRequestFrom(config: string): EmittedRequest {
  // curl sends a POST when it has form parts and no explicit method.
  let method: string | undefined;
  let path = '';
  const headers: string[] = [];
  const fields: { name: string; filename?: string }[] = [];
  for (const line of config.split('\n')) {
    const match = /^(\w+) = "(.*)"$/.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key === undefined || value === undefined) {
      continue;
    }
    if (key === 'url') {
      path = new URL(value).pathname;
    } else if (key === 'request') {
      method = value;
    } else if (key === 'header') {
      headers.push(value.slice(0, value.indexOf(':')));
    } else if (key === 'form') {
      const name = value.slice(0, value.indexOf('='));
      const file = /^[^=]*=@([^;]*)/.exec(value)?.[1];
      const filename = file?.split(/[\\/]/).at(-1);
      fields.push(filename === undefined ? { name } : { name, filename });
    }
  }
  return {
    method: method ?? (fields.length > 0 ? 'POST' : 'GET'),
    path,
    headers,
    multipart: fields.length > 0,
    fields,
  };
}
