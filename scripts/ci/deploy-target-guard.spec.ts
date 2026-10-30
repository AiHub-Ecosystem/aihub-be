import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type DeployTargetGuard = {
  classifyDeployTarget: (input: {
    targetSha: string;
    mainSha: string;
    cwd: string;
  }) => 'deploy' | 'superseded';
  describeDeployTarget: (input: {
    targetSha: string;
    mainSha: string;
    cwd: string;
  }) => { outcome: 'deploy' | 'superseded'; reason: string };
  parseActiveRevisions: (status: string) => string[];
  validateTestedPredecessor: (
    activeShas: string[],
    previousShas: string | string[],
    targetSha: string,
  ) => void;
  validateDeployTarget: (input: {
    targetSha: string;
    mainSha: string;
    activeShas: string[];
    cwd: string;
  }) => void;
};

function isDeployTargetGuard(value: unknown): value is DeployTargetGuard {
  return (
    typeof value === 'object' &&
    value !== null &&
    'classifyDeployTarget' in value &&
    typeof value.classifyDeployTarget === 'function' &&
    'describeDeployTarget' in value &&
    typeof value.describeDeployTarget === 'function' &&
    'parseActiveRevisions' in value &&
    typeof value.parseActiveRevisions === 'function' &&
    'validateTestedPredecessor' in value &&
    typeof value.validateTestedPredecessor === 'function' &&
    'validateDeployTarget' in value &&
    typeof value.validateDeployTarget === 'function'
  );
}

const deployTargetGuard: unknown = require('./deploy-target-guard.cjs');
if (!isDeployTargetGuard(deployTargetGuard)) {
  throw new Error('deploy-target-guard.cjs exports are invalid');
}
const {
  classifyDeployTarget,
  describeDeployTarget,
  parseActiveRevisions,
  validateDeployTarget,
  validateTestedPredecessor,
} = deployTargetGuard;

let repository: string;
let oldSha: string;
let mainSha: string;
let hostAheadSha: string;
let unrelatedSha: string;

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
  git('checkout', '--quiet', '--orphan', 'unrelated');
  git('rm', '--quiet', '-f', 'version.txt');
  unrelatedSha = commit('unrelated');
});

afterAll(() => {
  rmSync(repository, { recursive: true, force: true });
});

describe('CD deployment target guard', () => {
  it('stops deployment when a live tier differs from the tested predecessor', () => {
    expect(() =>
      validateTestedPredecessor([unrelatedSha], oldSha, mainSha),
    ).toThrow(/was not a tested predecessor/);
    expect(() =>
      validateTestedPredecessor([oldSha, mainSha], oldSha, mainSha),
    ).not.toThrow();
    expect(() => validateTestedPredecessor([oldSha], '', mainSha)).toThrow(
      /invalid/,
    );
    expect(() =>
      validateTestedPredecessor(
        [oldSha, hostAheadSha],
        [oldSha, hostAheadSha],
        mainSha,
      ),
    ).not.toThrow();
    expect(() =>
      validateTestedPredecessor([oldSha, hostAheadSha], oldSha, mainSha),
    ).toThrow(/was not a tested predecessor/);
  });
  it('classifies the current main tip for deployment', () => {
    expect(
      classifyDeployTarget({ targetSha: mainSha, mainSha, cwd: repository }),
    ).toBe('deploy');
  });

  it('classifies a target on main history as superseded', () => {
    expect(
      classifyDeployTarget({ targetSha: oldSha, mainSha, cwd: repository }),
    ).toBe('superseded');
  });

  it('refuses a target that is not on main history', () => {
    expect(() =>
      classifyDeployTarget({
        targetSha: unrelatedSha,
        mainSha,
        cwd: repository,
      }),
    ).toThrow(/not an ancestor of current main/);
  });

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

  it('allows a retry when the target is already active on one tier', () => {
    expect(() =>
      validateDeployTarget({
        targetSha: mainSha,
        mainSha,
        activeShas: [mainSha, oldSha],
        cwd: repository,
      }),
    ).not.toThrow();
  });

  it('allows a retry to finish host-job recovery when all tiers match target', () => {
    expect(() =>
      validateDeployTarget({
        targetSha: mainSha,
        mainSha,
        activeShas: [mainSha, mainSha],
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

  it('allows a Production caller-IP gate while resuming the Sandbox rollout', () => {
    expect(
      parseActiveRevisions(
        [
          `production active_slot=a sha=${oldSha} service=app`,
          `sandbox active_slot=b sha=${mainSha} service=app-sandbox`,
          'caller_ip_gate=production',
        ].join('\n'),
      ),
    ).toEqual([oldSha, mainSha]);
  });

  it('allows a release when Sandbox is disabled and only Production was tested', () => {
    const activeShas = parseActiveRevisions(
      [
        `production active_slot=a sha=${oldSha} service=app`,
        'sandbox disabled',
      ].join('\n'),
    );

    expect(activeShas).toEqual([oldSha]);
    expect(() =>
      validateTestedPredecessor(activeShas, oldSha, mainSha),
    ).not.toThrow();
  });

  it('requires a readable Production revision before allowing deployment', () => {
    expect(() => parseActiveRevisions('sandbox disabled')).toThrow(
      /Production revision is missing/,
    );
  });

  it.each([
    'caller_ip_gate=sandbox',
    'caller_ip_gate=unknown',
    'pending=2026-10-16 sandbox a old b main',
    'sandbox enabled but not routed',
  ])('refuses to deploy with unresolved host state: %s', (state) => {
    expect(() =>
      parseActiveRevisions(
        [`production active_slot=a sha=${oldSha} service=app`, state].join(
          '\n',
        ),
      ),
    ).toThrow(/unresolved/);
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

describe('CD deployment target after commits CI skips', () => {
  const CI_WORKFLOW = [
    'on:',
    '  push:',
    '    branches: [main]',
    '    paths:',
    '      - "**"',
    '      - "!*.md"',
    '      - "!**/*.md"',
    '      - "CHANGELOG.md"',
    '',
  ].join('\n');
  let ciRepository: string;
  let baseSha: string;
  let targetSha: string;

  function ciGit(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: ciRepository,
      encoding: 'utf8',
    }).trim();
  }

  /** Commits the given files on top of the current checkout. */
  function ciCommit(files: Record<string, string>): string {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(ciRepository, path)), { recursive: true });
      writeFileSync(join(ciRepository, path), content);
    }
    ciGit('add', '-A');
    ciGit('commit', '--quiet', '-m', Object.keys(files).join(','));
    return ciGit('rev-parse', 'HEAD');
  }

  function onTarget(): void {
    ciGit('checkout', '--quiet', '--detach', targetSha);
  }

  beforeAll(() => {
    ciRepository = mkdtempSync(join(tmpdir(), 'aihub-cd-ci-filter-'));
    execFileSync('git', ['init', '--quiet', '-b', 'main'], {
      cwd: ciRepository,
    });
    ciGit('config', 'user.name', 'CI guard test');
    ciGit('config', 'user.email', 'ci-guard@example.invalid');
    baseSha = ciCommit({
      '.github/workflows/ci.yml': CI_WORKFLOW,
      'src/a.ts': 'base',
    });
    targetSha = ciCommit({ 'src/a.ts': 'target' });
  });

  afterAll(() => {
    rmSync(ciRepository, { recursive: true, force: true });
  });

  it('still deploys a target that only Markdown commits CI skips come after', () => {
    onTarget();
    ciCommit({ 'notes/agents/note.md': 'note' });
    const mainSha = ciCommit({ 'notes/adr/example.md': 'adr' });

    expect(
      classifyDeployTarget({ targetSha, mainSha, cwd: ciRepository }),
    ).toBe('deploy');
    expect(
      describeDeployTarget({ targetSha, mainSha, cwd: ciRepository }).reason,
    ).toMatch(/2 file\(s\).*skipped by the CI push filter/);
    expect(() =>
      validateDeployTarget({
        targetSha,
        mainSha,
        activeShas: [baseSha],
        cwd: ciRepository,
      }),
    ).not.toThrow();
  });

  it('lets a later commit CI runs on supersede the target', () => {
    onTarget();
    ciCommit({ 'notes/agents/note.md': 'note' });
    const mainSha = ciCommit({ 'src/b.ts': 'later' });

    expect(
      classifyDeployTarget({ targetSha, mainSha, cwd: ciRepository }),
    ).toBe('superseded');
    expect(
      describeDeployTarget({ targetSha, mainSha, cwd: ciRepository }).reason,
    ).toMatch(/changes src\/b\.ts, which CI runs on/);
    expect(() =>
      validateDeployTarget({
        targetSha,
        mainSha,
        activeShas: [baseSha],
        cwd: ciRepository,
      }),
    ).toThrow(/not the current main tip/);
  });

  it('lets the changelog the release gate reads supersede the target', () => {
    onTarget();
    const mainSha = ciCommit({ 'CHANGELOG.md': 'entry' });

    expect(
      classifyDeployTarget({ targetSha, mainSha, cwd: ciRepository }),
    ).toBe('superseded');
  });

  it('keeps a target superseded when the CI push filter cannot be read', () => {
    ciGit('checkout', '--quiet', '--detach', baseSha);
    ciGit('checkout', '--quiet', '-b', 'no-filter');
    ciGit('rm', '--quiet', '-f', '.github/workflows/ci.yml');
    ciGit('commit', '--quiet', '-m', 'drop workflow');
    const mainSha = ciCommit({ 'notes/agents/note.md': 'note' });

    expect(
      classifyDeployTarget({ targetSha: baseSha, mainSha, cwd: ciRepository }),
    ).toBe('superseded');
  });

  it('deploys only runs whose CI succeeded', () => {
    const cd = readFileSync(
      join(__dirname, '../../.github/workflows/cd.yml'),
      'utf8',
    );
    expect(cd).toContain("github.event.workflow_run.conclusion == 'success'");
  });
});
