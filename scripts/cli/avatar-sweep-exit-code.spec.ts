import { createRequire } from 'node:module';

const cliExit = createRequire(import.meta.url)(
  './avatar-sweep-exit-code.cjs',
) as {
  avatarSweepExitCode(summary: {
    readonly failed: number;
    readonly stagingFailed: number;
  }): number;
};
const avatarSweepExitCode = (summary: {
  readonly failed: number;
  readonly stagingFailed: number;
}): number => cliExit.avatarSweepExitCode(summary);

describe('Avatar sweep CLI exit status', () => {
  it.each([
    [{ failed: 0, stagingFailed: 0 }, 0],
    [{ failed: 1, stagingFailed: 0 }, 1],
    [{ failed: 0, stagingFailed: 1 }, 1],
  ])('maps cleanup summary %o to exit status %i', (summary, status) => {
    expect(avatarSweepExitCode(summary)).toBe(status);
  });
});
