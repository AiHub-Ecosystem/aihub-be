import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * The local configuration path a demo actually follows: copy the example file,
 * fill in what its comments describe, start. A required runtime secret missing
 * from that file fails startup before a request is ever served, so the file has
 * to carry every variable the `env` secret source demands.
 */
const EXAMPLE = readFileSync('.env.example', 'utf8');
const DEMO_GUIDE = readFileSync('docs/local-demo.md', 'utf8');

/** The command the guidance tells a developer to run, checked for both files. */
const KEY_GENERATION = 'randomBytes(32)';

describe('local environment example', () => {
  it('declares the email outbox key bundle the env secret source requires', () => {
    const example = parseEnv(EXAMPLE);

    expect(Object.keys(example)).toEqual(
      expect.arrayContaining([
        'EMAIL_OUTBOX_CURRENT_KEY_ID',
        'EMAIL_OUTBOX_KEYS',
      ]),
    );
  });

  it('shows how to generate the key material that bundle carries', () => {
    // The values are left blank like every other secret here, so the only way a
    // copy of this file can start is by following the command next to it.
    expect(EXAMPLE).toContain(KEY_GENERATION);
    expect(EXAMPLE).toMatch(/EMAIL_OUTBOX_KEYS is a JSON object/);
  });

  it('tells the local demo how to set both outbox variables', () => {
    expect(DEMO_GUIDE).toContain('EMAIL_OUTBOX_CURRENT_KEY_ID');
    expect(DEMO_GUIDE).toContain('EMAIL_OUTBOX_KEYS');
    expect(DEMO_GUIDE).toContain(KEY_GENERATION);
  });
});
