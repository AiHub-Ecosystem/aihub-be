import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CI_PGBOUNCER,
  connectQueryTimeouts,
  renderCiPgBouncerConfig,
} from './render-pgbouncer-config';

const TEMPLATE = readFileSync(
  join(__dirname, '../../../ops/vault/templates/pgbouncer.ini.ctmpl'),
  'utf8',
);
const WORKFLOW = readFileSync(
  join(__dirname, '../../../.github/workflows/ci.yml'),
  'utf8',
);

describe('CI PgBouncer configuration renderer', () => {
  it('renders the production template and keeps its connect_query verbatim', () => {
    const config = renderCiPgBouncerConfig(TEMPLATE);
    const connectQuery = /connect_query='([^']*)'/.exec(TEMPLATE)?.[1];

    expect(connectQuery).toBeDefined();
    expect(config).toContain(`connect_query='${connectQuery}'`);
    expect(config).not.toContain('{{');
  });

  it('renders the CI alias and the template settings the lane runs', () => {
    const config = renderCiPgBouncerConfig(TEMPLATE);

    expect(config).toContain('[databases]');
    expect(config).toContain('[pgbouncer]');
    expect(config).toContain('pool_mode = transaction');
    expect(config).toContain('max_prepared_statements = 100');
    expect(config).toContain('query_wait_timeout = 0.25');
    expect(config).toContain(
      `${CI_PGBOUNCER.alias} = host=${CI_PGBOUNCER.databaseHost}`,
    );
    expect(config).toContain(`listen_port = ${CI_PGBOUNCER.listenPort}`);
  });

  it('reads the timeouts the connect_query sets', () => {
    expect(connectQueryTimeouts(TEMPLATE)).toEqual({
      statement: 4000,
      lock: 1000,
      idleTransaction: 10000,
    });
  });

  it('refuses a template whose connect_query lost a timeout', () => {
    const template = TEMPLATE.replace(
      ',set_config($$lock_timeout$$,$$1000$$,false)',
      '',
    );

    expect(() => connectQueryTimeouts(template)).toThrow(/lock_timeout/);
  });

  it('refuses a template with a value the probe cannot compare', () => {
    const template = TEMPLATE.replace(
      'set_config($$statement_timeout$$,$$4000$$,false)',
      'set_config($$statement_timeout$$,$$4s$$,false)',
    );

    expect(() => connectQueryTimeouts(template)).toThrow(/statement_timeout/);
  });

  it('refuses a template expression it does not fill', () => {
    const template = TEMPLATE.replace(
      'listen_addr = 0.0.0.0',
      'listen_addr = {{ .Data.data.listen_addr }}',
    );

    expect(() => renderCiPgBouncerConfig(template)).toThrow(
      /unsupported template expression/,
    );
  });

  it('starts the CI PgBouncer from the rendered file, not a second config', () => {
    // #1868: the database job must render the template and start PgBouncer
    // from that file. A `pgbouncer` service would be a second config.
    expect(WORKFLOW).toContain('render-pgbouncer-config.ts');
    expect(WORKFLOW).toContain(
      'temp/ci/pgbouncer/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro',
    );
    expect(WORKFLOW).not.toMatch(/^ {6}pgbouncer:$/m);
    // The timeouts come only from `connect_query`: no ALTER ROLE may set them.
    expect(WORKFLOW).not.toMatch(
      /ALTER ROLE [^;]*statement_timeout|ALTER ROLE [^;]*lock_timeout/,
    );
  });
});
