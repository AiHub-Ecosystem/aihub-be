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
