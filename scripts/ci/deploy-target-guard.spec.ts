import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DeployTargetGuard = {
  parseActiveRevisions: (status: string) => string[];
  validateDeployTarget: (input: {
    targetSha: string;
    mainSha: string;
    activeShas: string[];
    cwd: string;
  }) => void;
};

const { parseActiveRevisions, validateDeployTarget }: DeployTargetGuard =
  require('./deploy-target-guard.cjs');

let repository: string;
let oldSha: string;
let mainSha: string;
let hostAheadSha: string;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
}

function commit(version: string): string {
  writeFileSync(join(repository, 'version.txt'), version);
  git('add', 'version.txt');
  git('commit', '--quiet', '-m', version);
  return git('rev-parse', 'HEAD');
}

beforeAll(() => {
  repository = mkdtempSync(join(tmpdir(), 'aihub-cd-target-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repository });
  git('config', 'user.name', 'CI guard test');
  git('config', 'user.email', 'ci-guard@example.invalid');
  oldSha = commit('old');
  mainSha = commit('main');
  git('checkout', '--quiet', '-b', 'host-ahead');
  hostAheadSha = commit('host-ahead');
});

afterAll(() => {
  rmSync(repository, { recursive: true, force: true });
});

describe('CD deployment target guard', () => {
  it('rejects a successful CI rerun whose commit is no longer main', () => {
    expect(() =>
      validateDeployTarget({
        targetSha: oldSha,
        mainSha,
        activeShas: [oldSha],
        cwd: repository,
      }),
    ).toThrow(/not the current main tip/);
  });

  it('rejects a target that is an ancestor of a live tier revision', () => {
    expect(() =>
      validateDeployTarget({
        targetSha: mainSha,
        mainSha,
        activeShas: [hostAheadSha],
        cwd: repository,
      }),
    ).toThrow(/ancestor of active revision/);
  });

  it('allows the current main tip when it advances both live tiers', () => {
    expect(() =>
      validateDeployTarget({
        targetSha: mainSha,
        mainSha,
        activeShas: [oldSha],
        cwd: repository,
      }),
    ).not.toThrow();
  });

  it('reads active Production and routed Sandbox revisions from host status', () => {
    expect(
      parseActiveRevisions(
        [
          `production active_slot=a sha=${oldSha} service=app-slot-a`,
          `sandbox active_slot=b sha=${mainSha} service=app-sandbox-slot-b`,
          'pending=none',
        ].join('\n'),
      ),
    ).toEqual([oldSha, mainSha]);
  });

  it('requires a readable Production revision before allowing deployment', () => {
    expect(() => parseActiveRevisions('sandbox disabled')).toThrow(
      /Production revision is missing/,
    );
  });

  it('fails closed when an active tier revision is unavailable in Git history', () => {
    const missingSha = 'f'.repeat(40);
    expect(() =>
      validateDeployTarget({
        targetSha: mainSha,
        mainSha,
        activeShas: [missingSha],
        cwd: repository,
      }),
    ).toThrow(/active revision .* is unavailable/);
  });
});
