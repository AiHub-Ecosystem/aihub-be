import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { OPERATION_CATALOG } from './operation-catalog';

// The edge must not cut a call before AIHUB answers it. nginx's
// `proxy_read_timeout` and `proxy_send_timeout` come from the exact-match
// location for the route, else the `location /` block, else the server block.
// Writing /v2 grading runs 125 seconds, so a missing 135-second block for it
// would hand the customer a bare nginx 504 instead of AI_SERVICE_TIMEOUT
// (ADR-0143 decision 7).
const NGINX_DIR = resolve(process.cwd(), 'ops/nginx');

interface Block {
  readonly header: string;
  readonly directives: ReadonlyMap<string, string>;
  readonly children: readonly Block[];
}

function parseBlocks(text: string): Block[] {
  const root: {
    header: string;
    directives: Map<string, string>;
    children: Block[];
  } = {
    header: '',
    directives: new Map(),
    children: [],
  };
  const stack = [root];
  const cleaned = text.replace(/#[^\n]*/g, '');
  for (const token of cleaned.matchAll(/([^{};]+)([{};])/g)) {
    const body = (token[1] ?? '').trim();
    const end = token[2];
    const top = stack[stack.length - 1];
    if (top === undefined) throw new Error('unbalanced braces');
    if (end === '{') {
      const block = {
        header: body,
        directives: new Map<string, string>(),
        children: [] as Block[],
      };
      top.children.push(block);
      stack.push(block);
    } else if (end === '}') {
      stack.pop();
    } else if (body.length > 0) {
      const [name = '', ...rest] = body.split(/\s+/);
      if (!top.directives.has(name)) top.directives.set(name, rest.join(' '));
    }
  }
  return root.children;
}

function seconds(value: string | undefined): number | undefined {
  const match = /^(\d+)s$/.exec(value ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function servers(): Block[] {
  return readdirSync(NGINX_DIR)
    .filter((name) => name.endsWith('.conf'))
    .flatMap((name) =>
      parseBlocks(readFileSync(join(NGINX_DIR, name), 'utf8')).filter(
        (block) => block.header === 'server',
      ),
    )
    .filter((server) =>
      server.children.some(
        (child) =>
          child.header === 'location /' && child.directives.has('proxy_pass'),
      ),
    );
}

function effectiveTimeoutSeconds(
  server: Block,
  path: string,
  directive: 'proxy_read_timeout' | 'proxy_send_timeout',
): number | undefined {
  const exact = server.children.find(
    (child) => child.header === `location = ${path}`,
  );
  const fallback = server.children.find(
    (child) => child.header === 'location /',
  );
  return seconds(
    exact?.directives.get(directive) ??
      (exact === undefined ? fallback?.directives.get(directive) : undefined) ??
      server.directives.get(directive),
  );
}

describe('nginx edge timeouts', () => {
  const edgeServers = servers();

  it('finds the API and Sandbox servers', () => {
    expect(edgeServers).toHaveLength(2);
  });

  it.each(
    Object.entries(OPERATION_CATALOG).flatMap(([id, operation]) =>
      operation.path.includes('{')
        ? []
        : [[id, operation.path, operation.timeoutMs] as const],
    ),
  )(
    'keeps both proxy timeouts above the %s budget on every edge server (%s, %i ms)',
    (_id, path, timeoutMs) => {
      for (const server of edgeServers) {
        for (const directive of [
          'proxy_read_timeout',
          'proxy_send_timeout',
        ] as const) {
          const edge = effectiveTimeoutSeconds(server, path, directive);

          expect(edge).toBeDefined();
          expect((edge ?? 0) * 1_000).toBeGreaterThan(timeoutMs);
        }
      }
    },
  );

  it('gives the two Writing /v2 grading routes their own 135-second blocks and leaves other routes at 75', () => {
    for (const server of edgeServers) {
      for (const path of [
        '/v2/ielts/writing/task1/grade',
        '/v2/ielts/writing/task2/grade',
      ]) {
        expect(
          effectiveTimeoutSeconds(server, path, 'proxy_read_timeout'),
        ).toBe(135);
        expect(
          effectiveTimeoutSeconds(server, path, 'proxy_send_timeout'),
        ).toBe(135);
      }
      expect(
        effectiveTimeoutSeconds(
          server,
          '/v1/ielts/writing/task1/grade',
          'proxy_read_timeout',
        ),
      ).toBe(75);
    }
  });
});
