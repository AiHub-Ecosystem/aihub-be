/** @param {{ failed: number; stagingFailed: number }} summary */
function avatarSweepExitCode(summary) {
  return summary.failed > 0 || summary.stagingFailed > 0 ? 1 : 0;
}

module.exports = { avatarSweepExitCode };
