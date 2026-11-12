const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const DEFAULT_OUTPUT_DIR = 'temp/mutation-testing';

/**
 * @typedef {{command: string, args: string[], env: NodeJS.ProcessEnv, stdio: 'inherit'}} StrykerInvocation
 * @typedef {{outputDir?: string, execute?: (invocation: StrykerInvocation) => {status: number | null, error?: Error | null}}} MutationRunnerOptions
 */

/** @param {StrykerInvocation} invocation */
function executeStryker(invocation) {
  return childProcess.spawnSync(invocation.command, invocation.args, {
    env: invocation.env,
    stdio: invocation.stdio,
  });
}

/** @param {MutationRunnerOptions} [options] */
function runMutationTests(options = {}) {
  const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const reportPath = path.join(outputDir, 'mutation.json');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(reportPath, { force: true });

  const result = (options.execute ?? executeStryker)({
    command: 'bun',
    args: ['run', 'stryker', 'run'],
    env: { ...process.env, AIHUB_MUTATION_OUTPUT_DIR: outputDir },
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`mutation tests: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) return result.status ?? 1;

  try {
    if (!fs.existsSync(reportPath)) throw new Error('report file is missing');
    JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (error) {
    console.error(
      `mutation tests: Stryker completed without a valid JSON report at ${reportPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = runMutationTests();

module.exports = { runMutationTests };
