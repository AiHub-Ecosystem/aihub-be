import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { isRecord } from '@/common/is-record';
import { ALLOWED_EXTENSIONS } from '@/modules/speaking/infrastructure/fastify-speaking-multipart.parser';
import { buildOpenApiDocument } from '@/openapi/build-openapi-document';

import {
  type DeliberateOptionals,
  type EmittedRequest,
  type ExpectedRequest,
  MULTIPART,
  driftBetween,
  emittedRequestFrom,
  expectedRequestFrom,
} from '../support/smoke-request-contract';

// #1403: the Speaking smoke helper is operational tooling that nothing else
// exercises against the contract. Its request is derived here from the
// OpenAPI document built from source and compared with what the helper really
// writes for curl, so a contract change that the helper does not follow fails
// CI instead of failing an operator's rollback check.

const OPERATION_ID = 'speaking.grading';
const repositoryRoot = join(__dirname, '..', '..');
const helper = join(
  repositoryRoot,
  'scripts',
  'ops',
  'speaking',
  'speaking-gateway-smoke.sh',
);

const STUB_CURL = `#!/usr/bin/env bash
set -euo pipefail
config=''
response=''
while (($#)); do
  case "$1" in
    --config) config=$2; shift 2 ;;
    --output) response=$2; shift 2 ;;
    --write-out) shift 2 ;;
    *) shift ;;
  esac
done
cp -- "$config" "$AIHUB_SMOKE_CAPTURE_FILE"
: >"$response"
printf '200'
`;

/** Runs the real helper against a stub curl and returns the config it wrote. */
function runHelper(): string {
  const root = mkdtempSync(join(tmpdir(), 'aihub-smoke-contract-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'curl'), STUB_CURL);
    chmodSync(join(bin, 'curl'), 0o755);
    writeFileSync(join(root, 'api-key'), 'test-api-key\n');
    writeFileSync(join(root, 'identity'), 'smoke-user\n');
    writeFileSync(join(root, 'audio.wav'), '');
    const capture = join(root, 'captured-config');
    const pathKey =
      Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ??
      'PATH';
    const result = spawnSync('bash', [helper, join(root, 'audio.wav')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}`,
        TMPDIR: root,
        AIHUB_API_KEY_FILE: join(root, 'api-key'),
        AIHUB_USER_IDENTITY_FILE: join(root, 'identity'),
        AIHUB_SMOKE_CAPTURE_FILE: capture,
      },
    });
    if (result.status !== 0) {
      throw new Error(`helper failed: ${result.stderr}`);
    }
    return readFileSync(capture, 'utf8');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type Json = Record<string, unknown>;

function child(value: unknown, key: string): Json {
  const next = isRecord(value) ? value[key] : undefined;
  if (!isRecord(next)) {
    throw new Error(`the OpenAPI document has no "${key}" object`);
  }
  return next;
}

function items(value: unknown, key: string): unknown[] {
  const next = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(next)) {
    throw new Error(`the OpenAPI document has no "${key}" list`);
  }
  return next;
}

/** A copy of the generated document with the operation changed. */
function changedDocument(change: (operation: Json) => void): unknown {
  const document: unknown = JSON.parse(JSON.stringify(buildOpenApiDocument()));
  change(child(child(child(document, 'paths'), expected().path), 'post'));
  return document;
}

function expected(document: unknown = buildOpenApiDocument()): ExpectedRequest {
  return expectedRequestFrom(document, OPERATION_ID);
}

/** What a helper that follows the contract exactly would send. */
function conforming(contract: ExpectedRequest): EmittedRequest {
  return {
    method: contract.method,
    path: contract.path,
    headers: contract.headers.filter((h) => h.required).map((h) => h.name),
    multipart: true,
    fields: contract.fields
      .filter((field) => field.required)
      .map((field) => ({ name: field.name })),
  };
}

/** The optional fields the helper sends on purpose; it sends no optional header. */
const DELIBERATE: DeliberateOptionals = {
  fields: ['prompt_text', 'test_type'],
};

describe('Speaking smoke request against the public contract', () => {
  describe('driftBetween', () => {
    const contract = expected();

    it('finds no drift in a request that follows the contract', () => {
      expect(driftBetween(contract, conforming(contract))).toEqual([]);
    });

    it('names a header the contract does not accept (the retired X-User-Assertion)', () => {
      const stale = conforming(contract);

      expect(
        driftBetween(contract, {
          ...stale,
          headers: [...stale.headers, 'X-User-Assertion'],
        }),
      ).toEqual(['sends header "X-User-Assertion", which the contract lacks']);
    });

    it('names a required header the helper does not send', () => {
      const stale = conforming(contract);

      expect(
        driftBetween(contract, {
          ...stale,
          headers: stale.headers.filter(
            (name) => name.toLowerCase() !== 'x-user-identity',
          ),
        }),
      ).toEqual(['omits required header "X-User-Identity"']);
    });

    it('names a multipart field the contract does not define and a required one it omits', () => {
      const stale = conforming(contract);

      expect(
        driftBetween(contract, {
          ...stale,
          fields: [
            ...stale.fields.filter((field) => field.name !== 'question_id'),
            { name: 'language' },
          ],
        }),
      ).toEqual([
        'sends form field "language", which the contract lacks',
        'omits required form field "question_id"',
      ]);
    });

    it('names a changed method, path, or body encoding', () => {
      const stale = conforming(contract);

      expect(
        driftBetween(contract, {
          ...stale,
          method: 'PUT',
          path: '/v1/speaking/grading',
          multipart: false,
        }),
      ).toEqual([
        'sends PUT, the contract has POST',
        `sends to /v1/speaking/grading, the contract has ${contract.path}`,
        `does not send ${contract.mediaType}`,
      ]);
    });

    it('names an audio file whose extension the route rejects', () => {
      const stale = conforming(contract);

      expect(
        driftBetween(contract, {
          ...stale,
          fields: stale.fields.map((field) =>
            field.name === 'audio' ? { ...field, filename: 'clip.txt' } : field,
          ),
        }),
      ).toEqual([
        `sends audio file "clip.txt", whose extension the route rejects (it takes ${[...ALLOWED_EXTENSIONS].join(', ')})`,
      ]);
    });

    it('names a header or field that became optional while the helper still sends it', () => {
      const stale = conforming(contract);
      const optional = expected(
        changedDocument((operation) => {
          const schema = child(
            child(child(child(operation, 'requestBody'), 'content'), MULTIPART),
            'schema',
          );
          schema.required = items(schema, 'required').filter(
            (name) => name !== 'part',
          );
          operation.parameters = items(operation, 'parameters').map(
            (parameter) =>
              isRecord(parameter) &&
              parameter.$ref === '#/components/parameters/UserIdentity'
                ? { name: 'X-User-Identity', in: 'header', required: false }
                : parameter,
          );
        }),
      );

      expect(driftBetween(optional, stale)).toEqual([
        'sends header "X-User-Identity", which the contract no longer requires',
        'sends form field "part", which the contract no longer requires',
      ]);
    });

    it('names an optional the helper lists as deliberate that the contract now requires', () => {
      const stale = conforming(contract);

      expect(driftBetween(contract, stale, { fields: ['part'] })).toEqual([
        'lists form field "part" as optional, but the contract requires it',
      ]);
    });
  });

  describe('the repository helper', () => {
    it('sends exactly what the contract accepts and requires', () => {
      const emitted = emittedRequestFrom(runHelper());

      expect(driftBetween(expected(), emitted, DELIBERATE)).toEqual([]);
    });

    it('fails when the contract gains a required header the helper does not send', () => {
      const emitted = emittedRequestFrom(runHelper());
      const document = changedDocument((operation) => {
        items(operation, 'parameters').push({
          name: 'X-Tenant-Region',
          in: 'header',
          required: true,
          schema: { type: 'string' },
        });
      });

      expect(driftBetween(expected(document), emitted, DELIBERATE)).toEqual([
        'omits required header "X-Tenant-Region"',
      ]);
    });

    it('fails when the contract gains a required multipart field the helper does not send', () => {
      const emitted = emittedRequestFrom(runHelper());
      const document = changedDocument((operation) => {
        const schema = child(
          child(child(child(operation, 'requestBody'), 'content'), MULTIPART),
          'schema',
        );
        child(schema, 'properties').accent = { type: 'string' };
        items(schema, 'required').push('accent');
      });

      expect(driftBetween(expected(document), emitted, DELIBERATE)).toEqual([
        'omits required form field "accent"',
      ]);
    });

    it('fails when the contract drops a header the helper still sends', () => {
      const emitted = emittedRequestFrom(runHelper());
      const document = changedDocument((operation) => {
        operation.parameters = items(operation, 'parameters').filter(
          (parameter) =>
            !(
              isRecord(parameter) &&
              parameter.$ref === '#/components/parameters/UserIdentity'
            ),
        );
      });

      expect(driftBetween(expected(document), emitted, DELIBERATE)).toEqual([
        'sends header "X-User-Identity", which the contract lacks',
      ]);
    });
  });
});
