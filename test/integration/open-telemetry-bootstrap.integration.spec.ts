import { execFile } from 'node:child_process';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

interface Received {
  readonly path: string | undefined;
  readonly body: Buffer;
}

function listenForTraces(received: Received[]): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ path: request.url, body: Buffer.concat(chunks) });
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

function runProbe(endpoint: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve(process.cwd(), 'test/fixtures/otel-bootstrap-probe.ts'),
      ],
      {
        env: { ...process.env, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint },
        timeout: 20_000,
      },
      (error, _stdout, stderr) =>
        error === null
          ? resolvePromise()
          : reject(new Error(`probe failed: ${stderr}`)),
    );
  });
}

// CI Image boot runs with tracing off (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is
// empty there), and the unit specs build their own processors, so this is the
// one spec that starts the real NodeSDK from open-telemetry.ts and exports over
// OTLP. The probe runs in a child process because the OTLP exporter loads its
// HTTP agent with a dynamic `import()`, which Jest's CommonJS sandbox refuses.
describe('OpenTelemetry bootstrap', () => {
  it('starts the SDK from the configured endpoint and exports a span on shutdown', async () => {
    const received: Received[] = [];
    const server = await listenForTraces(received);
    const { port } = server.address() as AddressInfo;

    try {
      await runProbe(`http://127.0.0.1:${port}/v1/traces`);

      const traces = received.filter(({ path }) => path === '/v1/traces');
      expect(traces.length).toBeGreaterThan(0);
      // JSON and protobuf OTLP both carry the span name as plain bytes.
      expect(
        traces.some(({ body }) =>
          body.toString('latin1').includes('otel-bootstrap-probe'),
        ),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    }
  }, 30_000);
});
