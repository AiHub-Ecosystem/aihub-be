/**
 * Renders the CI PgBouncer configuration from the production Vault template
 * (#1868). The database lane used to set its timeouts with `ALTER ROLE` and to
 * write a separate PgBouncer config, so a broken quote or value in the
 * production `connect_query` passed CI and failed only on deploy.
 *
 * Only the values Vault supplies in production are filled in; the
 * `connect_query` literal and every other setting come from the template
 * verbatim. A template edit this renderer cannot follow fails the job rather
 * than shipping a config that stopped matching production.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../ops/vault/templates/pgbouncer.ini.ctmpl',
);

/** The CI topology, in place of the Vault-secret values production renders. */
export const CI_PGBOUNCER = {
  alias: 'aihub_db_lane',
  databaseHost: 'localhost',
  databasePort: 5432,
  databaseName: 'aihub_db_lane',
  maxDbConnections: 2,
  maxDbClientConnections: 64,
  maxClientConn: 64,
  // The published port the lane's client URL uses; production listens on 5432
  // inside its own container network.
  listenPort: 6432,
} as const;

export interface ConnectQueryTimeouts {
  readonly statement: number;
  readonly lock: number;
  readonly idleTransaction: number;
}

const TIMEOUT_SETTINGS = [
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
] as const;

/**
 * The three timeouts the template's `connect_query` sets, in milliseconds, so
 * the database-lane probe compares against the template and not a copy.
 */
export function connectQueryTimeouts(template: string): ConnectQueryTimeouts {
  const query = /connect_query='([^']*)'/.exec(template)?.[1];
  if (query === undefined) {
    throw new Error('the template carries no quoted connect_query literal');
  }
  const found = new Map<string, number>();
  for (const match of query.matchAll(
    /set_config\(\$\$([a-z_]+)\$\$,\$\$([^$]+)\$\$,false\)/g,
  )) {
    const [, name, raw] = match;
    if (name === undefined || raw === undefined) continue;
    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `connect_query ${name} must be an integer number of milliseconds`,
      );
    }
    found.set(name, Number(raw));
  }
  if (
    found.size !== TIMEOUT_SETTINGS.length ||
    TIMEOUT_SETTINGS.some((name) => !found.has(name))
  ) {
    throw new Error(
      `connect_query must set only ${TIMEOUT_SETTINGS.join(', ')}`,
    );
  }
  const valueOf = (name: (typeof TIMEOUT_SETTINGS)[number]): number =>
    found.get(name) as number;
  return {
    statement: valueOf('statement_timeout'),
    lock: valueOf('lock_timeout'),
    idleTransaction: valueOf('idle_in_transaction_session_timeout'),
  };
}

/**
 * Renders the production template for the CI topology and refuses anything it
 * cannot resolve.
 */
export function renderCiPgBouncerConfig(
  template: string,
  settings: typeof CI_PGBOUNCER = CI_PGBOUNCER,
): string {
  connectQueryTimeouts(template);

  const values: ReadonlyMap<string, string> = new Map([
    ['$alias', settings.alias],
    ['$database.host', settings.databaseHost],
    ['$database.port', String(settings.databasePort)],
    ['$database.database', settings.databaseName],
    ['$database.max_db_connections', String(settings.maxDbConnections)],
    [
      '$database.max_db_client_connections',
      String(settings.maxDbClientConnections),
    ],
    ['.Data.data.max_client_conn', String(settings.maxClientConn)],
  ]);

  const rendered = template
    .split(/\r?\n/)
    // Whole-line directives are control flow, not config.
    .filter((line) => !/^\{\{[^{}]*\}\}$/.test(line.trim()))
    .map((line) =>
      line.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, expression: string) => {
        const value = values.get(expression);
        if (value === undefined) {
          throw new Error(`unsupported template expression: ${match}`);
        }
        return value;
      }),
    )
    .join('\n')
    .replace(/^listen_port = .*$/m, `listen_port = ${settings.listenPort}`);

  for (const required of [
    '[databases]',
    '[pgbouncer]',
    'pool_mode = transaction',
    `${settings.alias} = `,
    "connect_query='",
  ]) {
    if (!rendered.includes(required)) {
      throw new Error(`the rendered config is missing ${required}`);
    }
  }
  return `${rendered.trimEnd()}\n`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const valueOf = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const out = valueOf('--out');
  const userlist = valueOf('--userlist');
  const poolerUrl = process.env['AIHUB_PGBOUNCER_TEST_URL']?.trim();
  if (out === undefined || userlist === undefined || poolerUrl === undefined) {
    throw new Error(
      'usage: --out <path> --userlist <path> (AIHUB_PGBOUNCER_TEST_URL required)',
    );
  }
  const url = new URL(poolerUrl);
  if (url.pathname !== `/${CI_PGBOUNCER.alias}`) {
    throw new Error(
      `the lane URL must name the ${CI_PGBOUNCER.alias} database alias`,
    );
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    renderCiPgBouncerConfig(readFileSync(TEMPLATE_PATH, 'utf8')),
  );
  mkdirSync(dirname(userlist), { recursive: true });
  // PgBouncer accepts a plaintext auth_file password for SCRAM client auth;
  // the lane's client sends the same secret from its connection URL.
  const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  writeFileSync(
    userlist,
    `${quote(decodeURIComponent(url.username))} ${quote(decodeURIComponent(url.password))}\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(
      `render-pgbouncer-config: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
