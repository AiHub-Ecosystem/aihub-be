import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface CliResult {
  readonly status: number;
  readonly stderr: string;
}

function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/cli.mjs', ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: '' },
      },
      (error, _stdout, stderr) => {
        const code = error?.code;
        resolve({
          status: typeof code === 'number' ? code : error === null ? 0 : 1,
          stderr,
        });
      },
    );
  });
}

describe('identity:set onboarding validation', () => {
  it('rejects a missing JWKS source before opening the database', async () => {
    const result = await runCli([
      'identity:set',
      '--org',
      'org_acme',
      '--issuer',
      'https://acme.edu',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Command failed');
  });

  it('rejects private inline key material before opening the database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aihub-identity-'));
    const file = join(directory, 'private.jwks.json');
    await writeFile(
      file,
      JSON.stringify({
        keys: [
          {
            kty: 'RSA',
            n: 'modulus',
            e: 'AQAB',
            d: 'private-exponent',
          },
        ],
      }),
      'utf8',
    );

    try {
      const result = await runCli([
        'identity:set',
        '--org',
        'org_acme',
        '--issuer',
        'https://acme.edu',
        '--public-keys-file',
        file,
      ]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Command failed');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['--jwks-url', 'http://acme.edu/.well-known/jwks.json'],
    ['--allowed-algorithms', 'HS256'],
    ['--max-assertion-ttl-seconds', '0'],
  ])('rejects invalid identity policy option %s', async (option, value) => {
    const result = await runCli([
      'identity:set',
      '--org',
      'org_acme',
      '--issuer',
      'https://acme.edu',
      '--jwks-url',
      'https://acme.edu/.well-known/jwks.json',
      option,
      value,
    ]);

    expect(result.status).toBe(2);
  });

  it('parses a valid remote configuration before requiring the database', async () => {
    const result = await runCli([
      'identity:set',
      '--org',
      'org_acme',
      '--issuer',
      'https://acme.edu',
      '--jwks-url',
      'https://acme.edu/.well-known/jwks.json',
    ]);

    expect(result.status).toBe(1);
  });
});
