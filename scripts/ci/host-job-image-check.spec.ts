import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { collectHostJobImagePaths } = require('./host-job-image-check.cjs') as {
  collectHostJobImagePaths: (repositoryRoot: string) => string[];
};

describe('host scheduled job image paths', () => {
  it('checks the container entrypoint and CLI paths used by the wrapper', () => {
    expect(collectHostJobImagePaths(process.cwd())).toEqual([
      '/app/scripts/runtime/runtime-entrypoint.mjs',
      '/app/scripts/cli/cli.mjs',
    ]);
  });

  it('fails when a versioned crontab wrapper path is missing', () => {
    const repository = mkdtempSync(join(tmpdir(), 'aihub-host-job-paths-'));
    const ops = join(repository, 'scripts', 'ops');
    const cron = join(repository, 'ops', 'host-jobs');
    mkdirSync(ops, { recursive: true });
    mkdirSync(cron, { recursive: true });
    writeFileSync(
      join(ops, 'host-scheduled-job.sh'),
      "readonly CONTAINER_RUNTIME_ENTRYPOINT='scripts/runtime/runtime-entrypoint.mjs'\nreadonly CONTAINER_CLI='scripts/cli/cli.mjs'\nquota) commands=(quota:reconcile)\n",
    );
    writeFileSync(
      join(cron, 'aihub.crontab'),
      '0 2 * * * @AIHUB_APP_DIR@/scripts/ops/missing-wrapper.sh quota\n',
    );
    mkdirSync(join(repository, 'scripts', 'cli'), { recursive: true });
    writeFileSync(
      join(repository, 'scripts', 'cli', 'cli.mjs'),
      "if (command === 'quota:reconcile') {}\n",
    );

    try {
      expect(() => collectHostJobImagePaths(repository)).toThrow(
        /crontab wrapper path does not exist/,
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
