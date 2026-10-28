const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

/** @param {string} status @returns {string[]} */
function parseActiveRevisions(status) {
  const revisions = [];
  const seen = new Set();

  for (const line of status.split(/\r?\n/)) {
    if (
      (line.startsWith('caller_ip_gate=') &&
        line !== 'caller_ip_gate=production') ||
      (line.startsWith('pending=') && line !== 'pending=none')
    ) {
      throw new Error(
        `refusing deployment with unresolved host state: ${line}`,
      );
    }
    if (line === 'sandbox enabled but not routed') {
      throw new Error('refusing deployment with unresolved Sandbox routing');
    }
    const tier = /^(production|sandbox)\b/.exec(line)?.[1];
    if (!tier) continue;
    if (tier === 'sandbox' && /^sandbox disabled$/.test(line)) continue;
    if (seen.has(tier))
      throw new Error(`duplicate ${tier} revision in host status`);
    seen.add(tier);
    const sha = /\bsha=([a-f0-9]{40})\b/.exec(line)?.[1];
    if (!sha)
      throw new Error(`${tier} revision is missing or invalid in host status`);
    revisions.push(sha);
  }

  if (!seen.has('production'))
    throw new Error('Production revision is missing from host status');
  return revisions;
}

/** @param {unknown} sha @returns {sha is string} */
const isSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha);

/** @param {{targetSha: string, mainSha: string, activeShas: string[], cwd: string}} options */
function validateDeployTarget({ targetSha, mainSha, activeShas, cwd }) {
  const outcome = classifyDeployTarget({ targetSha, mainSha, cwd });
  if (outcome === 'superseded') {
    throw new Error(
      `refusing to deploy ${targetSha}: it is not the current main tip (${mainSha})`,
    );
  }

  if (
    !Array.isArray(activeShas) ||
    activeShas.length === 0 ||
    activeShas.some((sha) => !isSha(sha))
  ) {
    throw new Error(
      'refusing to deploy: an active tier revision is missing or invalid',
    );
  }

  for (const activeSha of activeShas) {
    try {
      execFileSync('git', ['cat-file', '-e', `${activeSha}^{commit}`], {
        cwd,
        stdio: 'ignore',
      });
    } catch {
      throw new Error(
        `refusing to deploy: active revision ${activeSha} is unavailable in the checked-out Git history`,
      );
    }
    if (targetSha === activeSha) continue;
    const result = spawnSync(
      'git',
      ['merge-base', '--is-ancestor', targetSha, activeSha],
      { cwd, stdio: 'ignore' },
    );
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw new Error(
        `could not compare deploy target with active revision ${activeSha}`,
      );
    }
    if (result.status === 0) {
      throw new Error(
        `refusing to deploy ${targetSha}: it is an ancestor of active revision ${activeSha}; use the deliberate rollback path in #289`,
      );
    }
  }
}

/** @param {string[]} activeShas @param {string} previousSha @param {string} targetSha */
function validateTestedPredecessor(activeShas, previousSha, targetSha) {
  if (!isSha(previousSha)) throw new Error('tested predecessor SHA is invalid');
  for (const sha of activeShas) {
    if (sha !== previousSha && sha !== targetSha) {
      throw new Error(
        `refusing deployment: active revision ${sha} was not the tested predecessor ${previousSha}`,
      );
    }
  }
}

/** @param {{targetSha: string, mainSha: string, cwd: string}} options @returns {'deploy' | 'superseded'} */
function classifyDeployTarget({ targetSha, mainSha, cwd }) {
  if (!isSha(targetSha) || !isSha(mainSha)) {
    throw new Error(
      'deploy target and current main tip must be 40-character commit SHAs',
    );
  }
  for (const sha of [targetSha, mainSha]) {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
        cwd,
        stdio: 'ignore',
      });
    } catch {
      throw new Error(
        `refusing to classify deploy target: revision ${sha} is unavailable in the checked-out Git history`,
      );
    }
  }
  if (targetSha === mainSha) return 'deploy';

  const result = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', targetSha, mainSha],
    { cwd, stdio: 'ignore' },
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(
      `could not compare deploy target ${targetSha} with current main ${mainSha}`,
    );
  }
  if (result.status === 0) return 'superseded';
  throw new Error(
    `refusing to deploy ${targetSha}: it is not an ancestor of current main (${mainSha})`,
  );
}

module.exports = {
  classifyDeployTarget,
  parseActiveRevisions,
  validateTestedPredecessor,
  validateDeployTarget,
};

if (require.main === module) {
  try {
    const [targetSha, mainSha, mode, ...extra] = process.argv.slice(2);
    if (
      !targetSha ||
      !mainSha ||
      extra.length ||
      (mode !== '--classify' && !isSha(mode))
    ) {
      throw new Error(
        'usage: deploy-target-guard.cjs <target-sha> <current-main-sha> <--classify|tested-predecessor-sha>',
      );
    }

    if (mode === '--classify') {
      process.stdout.write(
        `${classifyDeployTarget({ targetSha, mainSha, cwd: process.cwd() })}\n`,
      );
    } else {
      const status = readFileSync(0, 'utf8');
      const activeShas = parseActiveRevisions(status);
      validateTestedPredecessor(activeShas, mode, targetSha);
      validateDeployTarget({
        targetSha,
        mainSha,
        activeShas,
        cwd: process.cwd(),
      });
      process.stdout.write(
        `deployment target ${targetSha} is current and does not roll back any active tier\n`,
      );
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : '';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
