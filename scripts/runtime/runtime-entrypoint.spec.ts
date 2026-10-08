import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENTRYPOINT = join(__dirname, 'runtime-entrypoint.mjs');
const RUNTIME_CONNECTION_LOADER = join(
  __dirname,
  '../../dist/modules/secrets/infrastructure/runtime-connection.environment.js',
);

// The deploy log is the only place an operator sees why a container exited, so
// the entrypoint's failure line has to carry the cause. A bare "runtime
// configuration failed" is what sent a failed sandbox deploy back to the Vault
// runbook without ever naming the missing field.
describe('runtime entrypoint failure reporting', () => {
  it('names the cause instead of printing a bare failure line', () => {
    // A target that is neither dist/ nor scripts/ fails the dynamic import,
    // which exercises the same catch as a malformed secret file.
    const result = spawnSync(process.execPath, [ENTRYPOINT, 'package.json'], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('runtime configuration failed:');
  });
});

// The entrypoint loads the built runtime-connection module, so this runs only
// where a build exists, such as a local `pnpm verify` after `pnpm build`, and
// is skipped otherwise. The check that matters is running an operator command
// in a deployed container.
const withBuild = existsSync(RUNTIME_CONNECTION_LOADER)
  ? describe
  : describe.skip;

withBuild('runtime entrypoint argument forwarding', () => {
  it('hands the target its own arguments, without the target path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aihub-entrypoint-'));
    try {
      const target = join(directory, 'echo-args.mjs');
      writeFileSync(
        target,
        'console.log(JSON.stringify(process.argv.slice(2)));',
      );

      const result = spawnSync(
        process.execPath,
        [
          ENTRYPOINT,
          pathToFileURL(target).href,
          'avatar:sweep',
          '--dry-run',
          'true',
        ],
        { encoding: 'utf8' },
      );

      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual([
        'avatar:sweep',
        '--dry-run',
        'true',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
