import { FastifyAdapter } from '@nestjs/platform-fastify';
import { type FastifyRequest, LogController } from 'fastify';

import { createRequestLogging } from './request-logger';

describe('createRequestLogging', () => {
  const originalLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    if (originalLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLevel;
    }
  });

  function level(): unknown {
    const { logger } = createRequestLogging();
    return typeof logger === 'object' ? logger.level : undefined;
  }

  it('defaults to info when LOG_LEVEL is not set', () => {
    delete process.env.LOG_LEVEL;

    expect(level()).toBe('info');
  });

  it('takes the level from LOG_LEVEL', () => {
    process.env.LOG_LEVEL = ' warn ';

    expect(level()).toBe('warn');
  });

  it('names LOG_LEVEL when its value is not a level', () => {
    process.env.LOG_LEVEL = 'verbose';

    expect(() => createRequestLogging()).toThrow(/LOG_LEVEL.*verbose/);
  });
});

describe('createRequestLogging against Fastify', () => {
  // The top-level `disableRequestLogging` option makes Fastify print a
  // deprecation notice at every boot and is removed in `fastify@6`; a
  // `logController` is its replacement.
  it('does not use the deprecated top-level option', () => {
    expect(createRequestLogging()).not.toHaveProperty('disableRequestLogging');
  });

  it('turns off the Fastify request lines through its log controller', () => {
    const { logController } = createRequestLogging();

    expect(logController).toBeInstanceOf(LogController);
    // The Request Completion Event is the only line that describes a response.
    expect(logController?.isLogDisabled({} as FastifyRequest)).toBe(true);
  });

  // `logController` is checked with `instanceof` against the Fastify the Nest
  // adapter loads, and an adapter built from a controller of another copy
  // throws at boot with a message about a controller that looks right.
  it('is accepted by the adapter the application boots with', () => {
    expect(
      () => new FastifyAdapter({ ...createRequestLogging() }),
    ).not.toThrow();
  });

  it('resolves one copy of Fastify for the project and for the Nest adapter', () => {
    const ours = require.resolve('fastify');
    const adapters = require.resolve('@nestjs/platform-fastify');

    expect(require.resolve('fastify', { paths: [adapters] })).toBe(ours);
  });
});
