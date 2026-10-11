const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

function requiredConstant(source, name) {
  const match = new RegExp(`^readonly ${name}='([^']+)'$`, 'm').exec(source);
  if (!match) throw new Error(`host job wrapper is missing ${name}`);
  return match[1];
}

function collectHostJobImagePaths(repositoryRoot) {
  const wrapperPath = path.join(
    repositoryRoot,
    'scripts/ops/host-scheduled-job.sh',
  );
  const wrapper = readFileSync(wrapperPath, 'utf8');
  const crontab = readFileSync(
    path.join(repositoryRoot, 'ops/host-jobs/aihub.crontab'),
    'utf8',
  );
  const cliSource = readFileSync(
    path.join(repositoryRoot, 'scripts/cli/cli.mjs'),
    'utf8',
  );
  const wrapperPaths = [
    ...crontab.matchAll(/@AIHUB_APP_DIR@(\/[^'"\s]+)/g),
  ].map((match) => match[1]);
  if (wrapperPaths.length === 0) {
    throw new Error('AIHUB crontab does not reference an installed wrapper');
  }

  for (const relativePath of wrapperPaths) {
    const repositoryPath = relativePath.slice(1);
    if (
      !relativePath.startsWith('/') ||
      repositoryPath.includes('..') ||
      path.isAbsolute(repositoryPath)
    ) {
      throw new Error(`unsafe crontab path: ${relativePath}`);
    }
    const hostPath = path.join(repositoryRoot, repositoryPath);
    if (!existsSync(hostPath)) {
      throw new Error(`crontab wrapper path does not exist: ${relativePath}`);
    }
  }

  const commands = [
    ...wrapper.matchAll(/^\s+[a-z-]+\) commands=\(([^)]*)\)/gm),
  ].flatMap((match) => match[1].split(/\s+/).filter(Boolean));
  if (commands.length === 0) {
    throw new Error('host job wrapper does not declare any CLI commands');
  }
  for (const command of commands) {
    if (!new RegExp(`command === ['"]${command}['"]`).test(cliSource)) {
      throw new Error(
        `host job command is not dispatched by scripts/cli/cli.mjs: ${command}`,
      );
    }
  }

  const imagePaths = [
    requiredConstant(wrapper, 'CONTAINER_RUNTIME_ENTRYPOINT'),
    requiredConstant(wrapper, 'CONTAINER_CLI'),
  ];
  for (const imagePath of imagePaths) {
    if (imagePath.startsWith('/') || imagePath.split('/').includes('..')) {
      throw new Error(`unsafe container script path: ${imagePath}`);
    }
  }
  return [...new Set(imagePaths.map((imagePath) => `/app/${imagePath}`))];
}

function checkImagePaths(image, repositoryRoot = process.cwd()) {
  if (!image) throw new Error('usage: host-job-image-check.cjs <image>');
  const imagePaths = collectHostJobImagePaths(repositoryRoot);
  const script =
    'const fs=require("node:fs"); for (const p of process.argv.slice(1)) { if (!fs.existsSync(p)) { console.error(`missing from image: ${p}`); process.exitCode=1; } }';
  const result = spawnSync(
    'docker',
    ['run', '--rm', '--entrypoint', 'node', image, '-e', script, ...imagePaths],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('host job image path check failed');
  process.stdout.write(
    `host job paths exist in ${image}: ${imagePaths.join(', ')}\n`,
  );
}

module.exports = { collectHostJobImagePaths };

if (require.main === module) {
  try {
    checkImagePaths(process.argv[2]);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
