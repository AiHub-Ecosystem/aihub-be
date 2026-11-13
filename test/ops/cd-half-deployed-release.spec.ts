import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { bashExecutable } from '../support/bash';

// A re-run of a half-deployed release must finish it, and a failed attempt must
// not leave the scheduled host jobs suspended (#1381, #1382). The remote script
// of the host-jobs step is run against stand-ins for the deploy helper and the
// host-jobs installer, so the decisions it takes are observed, not assumed.

const workflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/cd.yml'),
  'utf8',
);

function step(name: string, next: string): string {
  const start = workflow.indexOf(`      - name: ${name}`);
  const end = workflow.indexOf(`      - name: ${next}`);
  if (start < 0 || end < start) {
    throw new Error(`step ${name} not found`);
  }
  return workflow.slice(start, end);
}

function remoteScript(stepText: string): string {
  const open = stepText.indexOf("<<'REMOTE'");
  const close = stepText.indexOf('REMOTE\n', open + 1);
  const body = stepText.slice(stepText.indexOf('\n', open) + 1, close);
  return body
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

const TARGET = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);

function status(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

function tier(name: string, sha: string): string {
  return `${name} active_slot=a sha=${sha} service=app-${name}`;
}

function runHostJobsStep(
  statusText: string,
  deployOutcome: string,
  stepName = 'Install and smoke the scheduled host jobs',
  nextStep = 'Report active tier revisions',
): { code: number; stderr: string; calls: string } {
  const root = mkdtempSync(join(tmpdir(), 'cd-host-jobs-'));
  try {
    mkdirSync(join(root, 'scripts/ops/blue-green'), { recursive: true });
    mkdirSync(join(root, 'scripts/ops/host-jobs'), { recursive: true });
    mkdirSync(join(root, '.aihub-host-jobs-candidate'), { recursive: true });
    mkdirSync(join(root, '.aihub-host-jobs-state'), { recursive: true });
    writeFileSync(join(root, 'status.txt'), statusText);
    const helper = join(root, 'scripts/ops/blue-green/blue-green-host.sh');
    writeFileSync(helper, '#!/usr/bin/env bash\ncat "$APP_DIR/status.txt"\n');
    const installer = join(root, 'scripts/ops/host-jobs/install-host-jobs.sh');
    writeFileSync(
      installer,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$1" >>"$APP_DIR/calls.txt"\n',
    );
    const finishHelper = join(
      root,
      'scripts/ops/host-jobs/finish-host-jobs.sh',
    );
    writeFileSync(
      finishHelper,
      readFileSync(
        resolve(__dirname, '../../scripts/ops/host-jobs/finish-host-jobs.sh'),
        'utf8',
      ),
    );
    const candidateInstaller = join(
      root,
      '.aihub-host-jobs-candidate/install-host-jobs.sh',
    );
    const candidateFinishHelper = join(
      root,
      '.aihub-host-jobs-candidate/finish-host-jobs.sh',
    );
    writeFileSync(candidateInstaller, readFileSync(installer, 'utf8'));
    writeFileSync(candidateFinishHelper, readFileSync(finishHelper, 'utf8'));
    chmodSync(helper, 0o755);
    chmodSync(installer, 0o755);
    chmodSync(finishHelper, 0o755);
    chmodSync(candidateInstaller, 0o755);
    chmodSync(candidateFinishHelper, 0o755);
    const script = remoteScript(step(stepName, nextStep));
    const result = spawnSync(bashExecutable(), ['-se'], {
      input: script,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        APP_DIR: root,
        AIHUB_HOST_JOB_METRICS_DIR: join(root, 'metrics'),
        AIHUB_IMAGE: `ghcr.io/example/aihub:${TARGET}`,
        DEPLOY_OUTCOME: deployOutcome,
        TARGET_SHA: TARGET,
      },
    });
    let calls = '';
    try {
      calls = readFileSync(join(root, 'calls.txt'), 'utf8');
    } catch {
      // The installer was never called.
    }
    return { code: result.status ?? -1, stderr: result.stderr, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('CD finishing a half-deployed release', () => {
  describe('the Production step when Production already runs the target', () => {
    const production = step(
      'Deploy Production and verify caller IP',
      'Deploy Sandbox release and verify caller IP',
    );
    const skipStart = production.indexOf(
      'Production already runs target; skipping cutover',
    );
    const skip = production.slice(
      skipStart,
      production.indexOf('\n          else\n', skipStart),
    );

    it('reopens the caller-IP gate before the Sandbox step can need it', () => {
      expect(skip).toContain(
        './scripts/ops/blue-green/blue-green-host.sh resume production',
      );
    });

    it('does not resume over a gate an earlier attempt already left', () => {
      expect(skip).toContain('if [[ -z "$caller_ip_gate" ]]; then');
    });

    it('never rolls Production back on this path', () => {
      expect(skip).not.toContain('recover-gate');
      expect(skip).not.toContain('rollback');
    });
  });

  describe('the host-jobs step', () => {
    it('treats a skipped final health check as a failed deployment', () => {
      expect(
        step(
          'Install and smoke the scheduled host jobs',
          'Report active tier revisions',
        ),
      ).toContain(
        "DEPLOY_OUTCOME: ${{ steps.deploy.outcome == 'success' && 'success' || 'failure' }}",
      );
    });

    it('installs the jobs once both tiers run the target', () => {
      const result = runHostJobsStep(
        status([tier('production', TARGET), tier('sandbox', TARGET)]),
        'success',
      );

      expect(result.code).toBe(0);
      expect(result.calls).toBe('install\n');
    });

    it('keeps the schedule suspended when a failed attempt left tiers mixed', () => {
      const result = runHostJobsStep(
        status([tier('production', TARGET), tier('sandbox', OLDER)]),
        'failure',
      );

      expect(result.code).toBe(1);
      expect(result.calls).toBe('');
      expect(result.stderr).toContain('host jobs remain suspended');
    });

    it('names each tier revision and the target when the tiers are mixed', () => {
      const result = runHostJobsStep(
        status([tier('production', TARGET), tier('sandbox', OLDER)]),
        'failure',
      );

      expect(result.stderr).toContain(
        `active AIHUB tiers run mixed revisions (production=${TARGET.slice(0, 12)} sandbox=${OLDER.slice(0, 12)} target=${TARGET.slice(0, 12)})`,
      );
      expect(result.stderr).not.toContain(TARGET);
    });

    it('keeps the jobs suspended when a successful deploy is still mixed', () => {
      const result = runHostJobsStep(
        status([tier('production', TARGET), tier('sandbox', OLDER)]),
        'success',
      );

      expect(result.code).toBe(1);
      expect(result.calls).toBe('');
      expect(result.stderr).toContain('host jobs remain suspended');
    });

    it('keeps the jobs suspended when sync recovery sees mixed revisions', () => {
      const result = runHostJobsStep(
        status([tier('production', TARGET), tier('sandbox', OLDER)]),
        'failure',
        'Restore host files and schedule after sync failure',
        'Deploy Production and verify caller IP',
      );

      expect(result.code).toBe(1);
      expect(result.calls).toBe('');
      expect(result.stderr).toContain('host jobs remain suspended');
    });

    it('keeps the jobs suspended while a rollout or the gate is unresolved', () => {
      for (const line of [
        'pending=2026-10-29T00:00:00Z production a x y z',
        'caller_ip_gate=production',
      ]) {
        const result = runHostJobsStep(
          status([tier('production', TARGET), tier('sandbox', OLDER), line]),
          'failure',
        );

        expect(result.code).toBe(1);
        expect(result.calls).toBe('');
      }
    });
  });
});
