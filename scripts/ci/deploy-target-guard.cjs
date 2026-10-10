const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

function parseActiveRevisions(status) {
  const revisions = [];
  const seen = new Set();

  for (const line of status.split(/\r?\n/)) {
    const tier = /^(production|sandbox)\b/.exec(line)?.[1];
    if (!tier) continue;
    if (
      tier === 'sandbox' &&
      /^sandbox (?:disabled|enabled but not routed)$/.test(line)
    )
      continue;
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

function validateDeployTarget({ targetSha, mainSha, activeShas, cwd }) {
  const isSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha);
  if (!isSha(targetSha) || !isSha(mainSha)) {
    throw new Error(
      'deploy target and current main tip must be 40-character commit SHAs',
    );
  }
  if (targetSha !== mainSha) {
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

module.exports = { parseActiveRevisions, validateDeployTarget };

if (require.main === module) {
  try {
    const [targetSha, mainSha, ...extra] = process.argv.slice(2);
    if (!targetSha || !mainSha || extra.length) {
      throw new Error(
        'usage: deploy-target-guard.cjs <target-sha> <current-main-sha>',
      );
    }
    const status = readFileSync(0, 'utf8');
    validateDeployTarget({
      targetSha,
      mainSha,
      activeShas: parseActiveRevisions(status),
      cwd: process.cwd(),
    });
    process.stdout.write(
      `deployment target ${targetSha} is current and advances every active tier\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
