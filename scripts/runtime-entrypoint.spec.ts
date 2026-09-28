import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ENTRYPOINT = join(__dirname, 'runtime-entrypoint.mjs');

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
