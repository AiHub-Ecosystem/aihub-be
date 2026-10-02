import { type FastifyServerOptions, LogController } from 'fastify';

const DEFAULT_LOG_LEVEL = 'info';
const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

/**
 * Fails at boot, with the name of the setting, rather than letting Pino throw
 * an error about a level nobody can trace back to `LOG_LEVEL`.
 */
function configuredLogLevel(): string {
  const configured = process.env.LOG_LEVEL?.trim() || DEFAULT_LOG_LEVEL;
  const level = LOG_LEVELS.find((candidate) => candidate === configured);
  if (level === undefined) {
    throw new Error(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}; got "${configured}"`,
    );
  }

  return level;
}

/**
 * Where the lines go. Structural rather than Pino's own type because `pino` is
 * not a dependency of this project — Fastify brings it — so its stream type is
 * only reachable through Fastify's non-exported internals.
 */
export interface RequestLogStream {
  write(line: string): void;
}

/**
 * The adapter options that decide what AIHUB writes to stdout. Built by one
 * factory so the production bootstrap and the test that pins the Request
 * Completion Event's shape run the same configuration rather than a copy of it.
 */
export type RequestLogging = Pick<
  FastifyServerOptions,
  'logger' | 'logController'
>;

/**
 * Fastify's built-in Pino logger, with no logging dependency of its own.
 *
 * `stream` is what makes the shipped shape testable: the production bootstrap
 * omits it and gets stdout, while a test passes an in-memory destination and
 * reads the lines the process would have written.
 */
export function createRequestLogging(
  stream?: RequestLogStream,
): RequestLogging {
  return {
    // Fastify's own "incoming request" and "request completed" lines would
    // double every request in the log, so the Request Completion Event is the
    // only line that describes one response. The top-level
    // `disableRequestLogging` option does the same job but prints a
    // deprecation notice at every boot and goes away in `fastify@6`, so a
    // `logController` carries it instead.
    //
    // Fastify checks a `logController` with `instanceof`, against the copy of
    // `fastify` that `@nestjs/platform-fastify` loads. While the two resolve to
    // one module that holds; if they ever stop, the server refuses to boot.
    // `test/fastify-resolution.spec.ts` fails first and names the cause.
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      // Read here rather than passed in from the bootstrap because this file is
      // the explicit boundary adapter that builds the server's logging
      // configuration, the same way `open-telemetry.ts` reads its own.
      level: configuredLogLevel(),
      // `null` drops the pid and hostname bindings: lines stay identical
      // across replicas and carry nothing that differs per process.
      base: null,
      // `info` rather than `30`, so a level written by hand in a log query
      // matches what the line says.
      formatters: { level: (label) => ({ level: label }) },
      ...(stream === undefined ? {} : { stream }),
    },
  };
}
